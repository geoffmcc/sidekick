"use strict";

// B5 event consumption tests: fan-out is transactional with the append, an
// undrained subscription cannot grow without bound, the drainer is a real
// consumer that advances offsets, stale claims are recovered, and the event
// vocabulary matches what src/ actually publishes. No network required.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-event-consumption");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
delete process.env.SIDEKICK_EVENT_BACKLOG_CAP;
delete process.env.SIDEKICK_EVENT_DRAIN_INTERVAL_MS;
delete process.env.SIDEKICK_EVENT_DRAIN_BATCH;

delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
const kernel = require("../src/platform/kernel");
const drainer = require("../src/platform/event-drainer");
const vocabulary = require("../src/platform/event-vocabulary");
const { createEventDeliveryStore } = require("../src/platform/event-delivery");

console.log("Running platform event consumption tests...\n");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

function resetEvents() {
  kernel.ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  // Delete in dependency order. The graph is not obvious: transitions reference
  // events, and events themselves reference executions, so executions must go
  // LAST rather than first.
  db.exec([
    "DELETE FROM platform_event_deliveries;",
    "DELETE FROM platform_event_offsets;",
    "DELETE FROM platform_event_subscriptions;",
    "DELETE FROM platform_execution_transitions;",
    "DELETE FROM platform_execution_events;",
    "DELETE FROM platform_execution_claims;",
    "DELETE FROM platform_executions;",
  ].join(" "));
  drainer.clearHandlers();
  delete process.env.SIDEKICK_EVENT_BACKLOG_CAP;
}

test("event delivery exposes a narrow factory and preserves delivery redaction at the boundary", () => {
  assert.strictEqual(typeof createEventDeliveryStore, "function");
  const store = createEventDeliveryStore({
    ensureSchema() {},
    getDb() { throw new Error("database should not be needed for event preparation"); },
    eventVocabulary: vocabulary,
    redactSensitiveKeysDeep(value) { return { ...value, token: "[REDACTED]" }; },
    json: JSON.stringify,
    parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } },
    nowIso: () => "2026-01-01T00:00:00.000Z",
    newId: prefix => `${prefix}_test`,
    runWithCausation: (_eventId, fn) => fn(),
  });
  assert.strictEqual(typeof store.registerEventSubscription, "function");
  const delivered = store.prepareDeliveredEvent({ payload_json: JSON.stringify({ token: "secret" }), redaction_state: "unknown" });
  assert.strictEqual(delivered.redacted_by_delivery, true);
  assert.strictEqual(delivered.payload.token, "[REDACTED]");
});

// ---- vocabulary -------------------------------------------------------------

test("vocabulary enforces event_type shape and reports unknown namespaces", () => {
  assert.strictEqual(vocabulary.validateSubscriptionEventType("execution.failed").valid, true);
  assert.strictEqual(vocabulary.validateSubscriptionEventType("*").wildcard, true);
  assert.strictEqual(vocabulary.validateSubscriptionEventType("execution failed").valid, false, "whitespace is rejected");
  assert.strictEqual(vocabulary.validateSubscriptionEventType("Execution.Failed").valid, false, "uppercase is rejected");
  assert.strictEqual(vocabulary.validateSubscriptionEventType("nodots").valid, false, "a namespace is required");
  const unknown = vocabulary.validateSubscriptionEventType("frobnicator.exploded");
  assert.strictEqual(unknown.valid, true, "an unknown namespace is allowed");
  assert.strictEqual(unknown.unknown_namespace, true, "but it is reported");
});

test("every event_type published by src/ has a registered namespace", () => {
  // Keeps the vocabulary honest as new publishers land: the file is a snapshot,
  // and a snapshot nothing checks goes stale silently. Two forms are published —
  // `event_type:` directly, and a type passed positionally into one of the
  // publisher helpers — so both are scanned.
  const SRC = path.join(__dirname, "..", "src");
  const files = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)) files.push(fs.readFileSync(full, "utf8"));
    }
  };
  visit(SRC);
  const source = files.join("\n");
  const direct = [...source.matchAll(/event_type:\s*"([a-z0-9_.]+)"/g)].map(m => m[1]);
  const helperCalls = [...source.matchAll(/(?:appendScheduledPlatformEvent|recordPlatformApprovalEvent|appendAgentExecutionEvent|appendPlatformCaptureEvent|recordPackEvent|onEvent)\([\s\S]*?\)/g)].flatMap(m =>
    [...m[0].matchAll(/"([a-z][a-z0-9_]*\.[a-z0-9_.]+)"/g)].map(x => x[1])
  );
  const published = Array.from(new Set([...direct, ...helperCalls]));
  assert.ok(published.length > 90, `expected to find the publisher event types, found ${published.length}`);
  const orphans = published.filter(t => !vocabulary.isKnownNamespace(t));
  assert.deepStrictEqual(orphans, [], `event types with no namespace in event-vocabulary.js: ${orphans.join(", ")}`);
});

test("subscription registration rejects a malformed event_type", () => {
  resetEvents();
  assert.throws(() => kernel.registerEventSubscription({ name: "bad-type", event_type: "not a type" }), /dotted lower_snake_case/);
  assert.strictEqual(kernel.listEventSubscriptions().length, 0, "nothing is stored for a rejected type");
});

test("subscription registration records an unknown namespace on the subscription", () => {
  resetEvents();
  const sub = kernel.registerEventSubscription({ name: "future-subsystem", event_type: "frobnicator.exploded" });
  assert.strictEqual(sub.metadata.unknown_namespace, true, "the advisory finding is durable, not just logged");
});

// ---- transactional fan-out --------------------------------------------------

test("fan-out is committed in the same transaction as the append", () => {
  resetEvents();
  const sub = kernel.registerEventSubscription({ name: "txn-subscriber", event_type: "delivery.test" });
  const event = kernel.appendEvent({ event_type: "delivery.test", source: "test", payload: { n: 1 } });
  const deliveries = kernel.listEventDeliveries({ subscription_id: sub.subscription_id });
  assert.strictEqual(deliveries.length, 1, "the delivery exists");
  assert.strictEqual(deliveries[0].event_id, event.event_id);

  // If the fan-out fails, the event must not be in the ledger either: an event
  // committed without its deliveries is invisibly lost to every consumer.
  const db = dbStore.getDb();
  const before = db.prepare("SELECT COUNT(*) AS c FROM platform_execution_events").get().c;
  db.exec("CREATE TEMP TRIGGER block_fanout BEFORE INSERT ON platform_event_deliveries BEGIN SELECT RAISE(ABORT, 'fan-out unavailable'); END");
  try {
    assert.throws(() => kernel.appendEvent({ event_type: "delivery.test", source: "test", payload: { n: 2 } }), /fan-out unavailable/);
  } finally {
    db.exec("DROP TRIGGER block_fanout");
  }
  const after = db.prepare("SELECT COUNT(*) AS c FROM platform_execution_events").get().c;
  assert.strictEqual(after, before, "the append rolled back with its fan-out");
});

test("appending with no matching subscription still stores the event", () => {
  resetEvents();
  const event = kernel.appendEvent({ event_type: "delivery.unsubscribed", source: "test" });
  assert.ok(event.event_id, "publishers do not depend on a consumer existing");
  assert.strictEqual(kernel.listEventDeliveries({}).length, 0);
});

// ---- backlog cap ------------------------------------------------------------

test("an undrained subscription is auto-paused at the backlog cap", () => {
  resetEvents();
  process.env.SIDEKICK_EVENT_BACKLOG_CAP = "10";
  assert.strictEqual(kernel.getEventBacklogCap(), 10);
  const sub = kernel.registerEventSubscription({ name: "hungry-subscriber", event_type: "delivery.flood" });
  for (let i = 0; i < 15; i++) kernel.appendEvent({ event_type: "delivery.flood", source: "test", payload: { i } });

  const stored = kernel.listEventSubscriptions().find(s => s.subscription_id === sub.subscription_id);
  assert.strictEqual(stored.state, "paused", "the subscription is paused, not left growing");
  assert.ok(stored.metadata.auto_paused_at, "the pause is recorded for the operator");
  assert.match(stored.metadata.auto_pause_reason, /backlog cap/);

  const deliveries = kernel.listEventDeliveries({ subscription_id: sub.subscription_id, limit: 100 });
  assert.strictEqual(deliveries.length, 10, "the backlog stopped at the cap");
  assert.strictEqual(kernel.listEventDeliveries({ limit: 100 }).length, 10);

  // The publisher is never blocked or failed by a stalled consumer.
  const later = kernel.appendEvent({ event_type: "delivery.flood", source: "test", payload: { late: true } });
  assert.ok(later.event_id, "publishing continues after a subscription is paused");
  delete process.env.SIDEKICK_EVENT_BACKLOG_CAP;
});

test("the cap is floored so a misconfiguration cannot pause everything", () => {
  process.env.SIDEKICK_EVENT_BACKLOG_CAP = "0";
  assert.strictEqual(kernel.getEventBacklogCap(), 10);
  process.env.SIDEKICK_EVENT_BACKLOG_CAP = "not-a-number";
  assert.strictEqual(kernel.getEventBacklogCap(), 10000);
  delete process.env.SIDEKICK_EVENT_BACKLOG_CAP;
});

// ---- drainer ----------------------------------------------------------------

test("the drainer delivers pending events to a registered handler and advances the offset", () => {
  resetEvents();
  const received = [];
  const sub = drainer.registerHandler("test.consumer", event => received.push(event), { event_type: "delivery.drain" });
  const event = kernel.appendEvent({ event_type: "delivery.drain", source: "test", payload: { value: 42 } });

  const summary = drainer.drainOnce();
  assert.strictEqual(summary.delivered, 1, "one delivery succeeded");
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(received.length, 1, "the handler ran");
  assert.strictEqual(received[0].payload.value, 42, "the handler receives the decoded payload");

  const offset = dbStore.getDb().prepare("SELECT * FROM platform_event_offsets WHERE subscription_id = ?").get(sub.subscription_id);
  assert.strictEqual(offset.last_event_id, event.event_id, "the consumer offset advanced");
  assert.strictEqual(kernel.getEventDeliveryStats().delivered, 1);
  assert.strictEqual(drainer.drainOnce().delivered, 0, "a delivered event is not redelivered");
});

test("the drainer retries a failing handler and dead-letters it at max_attempts", () => {
  resetEvents();
  drainer.registerHandler("flaky.consumer", () => { throw new Error("handler blew up"); }, { event_type: "delivery.flaky", max_attempts: 2 });
  kernel.appendEvent({ event_type: "delivery.flaky", source: "test" });

  const first = drainer.drainOnce();
  assert.strictEqual(first.failed, 1, "a throwing handler is a failed delivery, not a crashed drainer");
  let delivery = kernel.listEventDeliveries({})[0];
  assert.strictEqual(delivery.status, "retry");

  // Retry backoff is real time; clear it rather than sleeping.
  dbStore.getDb().prepare("UPDATE platform_event_deliveries SET next_attempt_at = ? WHERE delivery_id = ?").run(new Date(0).toISOString(), delivery.delivery_id);
  drainer.drainOnce();
  delivery = kernel.listEventDeliveries({})[0];
  assert.strictEqual(delivery.status, "dead_letter", "attempts are bounded by max_attempts");
  assert.match(delivery.last_error, /handler blew up/);
});

test("deliveries for a subscription with no handler are left pending, not acked", () => {
  resetEvents();
  kernel.registerEventSubscription({ name: "orphan-subscriber", event_type: "delivery.orphan" });
  kernel.appendEvent({ event_type: "delivery.orphan", source: "test" });

  const summary = drainer.drainOnce();
  assert.strictEqual(summary.skipped_no_handler, 1, "the gap is reported");
  assert.strictEqual(summary.delivered, 0, "nothing is marked delivered that nothing consumed");
  assert.strictEqual(kernel.listEventDeliveries({})[0].status, "pending");
});

test("a paused subscription receives no fan-out and no delivery", () => {
  resetEvents();
  const sub = drainer.registerHandler("paused.consumer", () => {}, { event_type: "delivery.paused" });
  kernel.setEventSubscriptionState(sub.subscription_id, "paused");
  kernel.appendEvent({ event_type: "delivery.paused", source: "test" });
  assert.strictEqual(kernel.listEventDeliveries({}).length, 0, "paused means not delivered");

  kernel.setEventSubscriptionState(sub.subscription_id, "active");
  kernel.appendEvent({ event_type: "delivery.paused", source: "test" });
  assert.strictEqual(drainer.drainOnce().delivered, 1, "resuming restores fan-out for new events");
});

test("re-registering a handler reuses the stored subscription and keeps its state", () => {
  resetEvents();
  const first = drainer.registerHandler("stable.consumer", () => {}, { event_type: "delivery.stable" });
  kernel.setEventSubscriptionState(first.subscription_id, "paused");
  const second = drainer.registerHandler("stable.consumer", () => {}, { event_type: "delivery.stable" });
  assert.strictEqual(second.subscription_id, first.subscription_id, "no duplicate subscription per restart");
  const stored = kernel.listEventSubscriptions().find(s => s.subscription_id === first.subscription_id);
  assert.strictEqual(stored.state, "paused", "a restart does not silently un-pause an operator's decision");
  assert.deepStrictEqual(drainer.listHandlers(), ["stable.consumer"]);
});

test("a delivery stuck in-flight is reclaimed and remains attempt-bounded", () => {
  resetEvents();
  drainer.registerHandler("crashy.consumer", () => {}, { event_type: "delivery.stuck", max_attempts: 3 });
  kernel.appendEvent({ event_type: "delivery.stuck", source: "test" });
  const delivery = kernel.listEventDeliveries({})[0];

  // Simulate a process that died holding the claim.
  const stale = new Date(Date.now() - 3600_000).toISOString();
  dbStore.getDb().prepare("UPDATE platform_event_deliveries SET status = 'in_flight', attempt_count = 1, updated_at = ? WHERE delivery_id = ?").run(stale, delivery.delivery_id);
  assert.strictEqual(kernel.recoverStaleEventDeliveries({ olderThanMs: 60_000 }), 1);
  assert.strictEqual(kernel.listEventDeliveries({})[0].status, "retry", "the claim is released for another attempt");

  // A stuck delivery that already burned its attempts must not retry forever.
  dbStore.getDb().prepare("UPDATE platform_event_deliveries SET status = 'in_flight', attempt_count = 3, updated_at = ? WHERE delivery_id = ?").run(stale, delivery.delivery_id);
  kernel.recoverStaleEventDeliveries({ olderThanMs: 60_000 });
  assert.strictEqual(kernel.listEventDeliveries({})[0].status, "dead_letter");

  // A fresh claim is left alone.
  dbStore.getDb().prepare("UPDATE platform_event_deliveries SET status = 'in_flight', updated_at = ? WHERE delivery_id = ?").run(new Date().toISOString(), delivery.delivery_id);
  assert.strictEqual(kernel.recoverStaleEventDeliveries({ olderThanMs: 60_000 }), 0, "an in-flight delivery in progress is not stolen");
});

test("claimable work excludes paused subscriptions and not-yet-due retries", () => {
  resetEvents();
  const sub = drainer.registerHandler("due.consumer", () => {}, { event_type: "delivery.due" });
  kernel.appendEvent({ event_type: "delivery.due", source: "test" });
  assert.strictEqual(kernel.listClaimableEventDeliveries({}).length, 1);

  const delivery = kernel.listEventDeliveries({})[0];
  dbStore.getDb().prepare("UPDATE platform_event_deliveries SET status = 'retry', next_attempt_at = ? WHERE delivery_id = ?")
    .run(new Date(Date.now() + 3600_000).toISOString(), delivery.delivery_id);
  assert.strictEqual(kernel.listClaimableEventDeliveries({}).length, 0, "backoff is respected");

  dbStore.getDb().prepare("UPDATE platform_event_deliveries SET next_attempt_at = NULL WHERE delivery_id = ?").run(delivery.delivery_id);
  kernel.setEventSubscriptionState(sub.subscription_id, "paused");
  assert.strictEqual(kernel.listClaimableEventDeliveries({}).length, 0, "a paused subscription yields no work");
});

test("the built-in consumers subscribe to failure events and run through the drainer", () => {
  resetEvents();
  const result = drainer.registerBuiltinConsumers();
  assert.deepStrictEqual(result.errors, [], "built-in consumers register cleanly");
  assert.strictEqual(result.registered.length, drainer.BUILTIN_CONSUMERS.length);

  const names = kernel.listEventSubscriptions().map(s => s.name).sort();
  assert.deepStrictEqual(names, drainer.BUILTIN_CONSUMERS.map(c => c.name).sort());
  for (const consumer of drainer.BUILTIN_CONSUMERS) {
    assert.notStrictEqual(consumer.event_type, "*", "the built-in consumers are scoped, not a wildcard fan-out of every event");
  }

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    kernel.appendEvent({ event_type: "execution.failed", source: "test", severity: "error", subject_type: "execution", subject_id: "exec_test", payload: { reason: "boom" } });
    const summary = drainer.drainOnce();
    assert.strictEqual(summary.delivered, 1, "a real failure event reaches a real consumer");
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some(line => line.includes("platform.event.alert") && line.includes("execution.failed")), "the consumer emits a structured alert");

  // Events the built-ins do not subscribe to create no delivery rows at all.
  kernel.appendEvent({ event_type: "execution.running", source: "test" });
  assert.strictEqual(drainer.drainOnce().delivered, 0, "unsubscribed types cost nothing");
});

test("the drain loop starts, is idempotent, and stops", () => {
  resetEvents();
  assert.strictEqual(drainer.isRunning(), false);
  const started = drainer.startDrainer({ intervalMs: 60_000 });
  assert.strictEqual(started.started, true);
  assert.strictEqual(drainer.startDrainer({ intervalMs: 60_000 }).reason, "already_running", "a second start is refused");
  assert.strictEqual(drainer.isRunning(), true);
  assert.strictEqual(drainer.stopDrainer().stopped, true);
  assert.strictEqual(drainer.isRunning(), false);
});

// ---- causation (B5 residual) ------------------------------------------------

test("an event published while handling another event inherits it as its cause", () => {
  resetEvents();
  // The textbook causation case, and the one that only became real once a
  // consumer existed to publish from.
  drainer.registerHandler("causing.consumer", () => {
    kernel.appendEvent({ event_type: "delivery.derived", source: "test", payload: { derived: true } });
  }, { event_type: "delivery.cause" });

  const cause = kernel.appendEvent({ event_type: "delivery.cause", source: "test" });
  assert.strictEqual(drainer.drainOnce().delivered, 1);

  const derived = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'delivery.derived'").get();
  assert.strictEqual(derived.causation_id, cause.event_id, "the handled event is recorded as the cause");
  assert.strictEqual(kernel.getAmbientCausationId(), null, "the context does not leak past the delivery");
});

test("an explicit causation_id always wins over the ambient one", () => {
  resetEvents();
  drainer.registerHandler("explicit.consumer", () => {
    kernel.appendEvent({ event_type: "delivery.derived", source: "test", causation_id: "evt_explicit" });
  }, { event_type: "delivery.cause" });
  kernel.appendEvent({ event_type: "delivery.cause", source: "test" });
  drainer.drainOnce();
  const derived = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'delivery.derived'").get();
  assert.strictEqual(derived.causation_id, "evt_explicit");
});

test("execution state changes form a causal chain", () => {
  resetEvents();
  const execution = kernel.createExecution({ kind: "test", actor_id: "tester", source: "test" });
  kernel.transitionExecution(execution.execution_id, "running", { source: "test" });
  kernel.transitionExecution(execution.execution_id, "completed", { source: "test" });

  const events = dbStore.getDb()
    .prepare("SELECT event_id, event_type, causation_id FROM platform_execution_events WHERE execution_id = ? AND event_type LIKE 'execution.%' ORDER BY rowid")
    .all(execution.execution_id);
  const running = events.find(e => e.event_type === "execution.running");
  const completed = events.find(e => e.event_type === "execution.completed");
  assert.ok(running && completed, "both transitions were recorded");
  assert.strictEqual(completed.causation_id, running.event_id, "each state change is caused by the one before it");
});

// ---- payload safety on delivery (B5 residual) -------------------------------

test("a payload not stored redacted is redacted before it reaches a handler", () => {
  resetEvents();
  // 44% of the production ledger is redaction_state "none" — module transitions
  // and pack events keep raw error text on purpose. Consuming it is what makes
  // it leave the database.
  let seen = null;
  drainer.registerHandler("redact.consumer", event => { seen = event; }, { event_type: "delivery.raw" });
  kernel.appendEvent({
    event_type: "delivery.raw",
    source: "test",
    redaction_state: "none",
    payload: { error: "connect failed with Authorization: Bearer sk-live-abcdef", token: "sk-live-abcdef" },
  });
  assert.strictEqual(drainer.drainOnce().delivered, 1);

  assert.strictEqual(seen.redacted_by_delivery, true, "the handler is told the payload was redacted in transit");
  assert.strictEqual(seen.original_redaction_state, "none");
  assert.strictEqual(seen.redaction_state, "redacted");
  assert.ok(!JSON.stringify(seen.payload).includes("sk-live-abcdef"), "no credential survives into handler code");

  const stored = dbStore.getDb().prepare("SELECT payload_json, redaction_state FROM platform_execution_events WHERE event_type = 'delivery.raw'").get();
  assert.strictEqual(stored.redaction_state, "none", "the ledger still records honestly what was stored");
  assert.ok(stored.payload_json.includes("sk-live-abcdef"), "delivery redaction does not rewrite history");
});

test("a subscription may opt in to unredacted payloads, explicitly", () => {
  resetEvents();
  let seen = null;
  drainer.registerHandler("raw.consumer", event => { seen = event; }, { event_type: "delivery.raw", accepts_unredacted: true });
  const sub = kernel.listEventSubscriptions().find(s => s.name === "raw.consumer");
  assert.strictEqual(sub.metadata.accepts_unredacted, true, "the opt-in is durable and inspectable, not a handler-side flag");

  kernel.appendEvent({ event_type: "delivery.raw", source: "test", redaction_state: "none", payload: { error: "raw sk-live-abcdef" } });
  drainer.drainOnce();
  assert.strictEqual(seen.redacted_by_delivery, false);
  assert.ok(seen.payload.error.includes("sk-live-abcdef"), "the opted-in consumer receives the raw text");
});

test("a payload declared already-redacted is passed through untouched", () => {
  resetEvents();
  let seen = null;
  drainer.registerHandler("passthrough.consumer", event => { seen = event; }, { event_type: "delivery.clean" });
  // The publisher must SAY it redacted. Delivery trusts this label, so it is
  // an explicit claim, never an omission.
  kernel.appendEvent({ event_type: "delivery.clean", source: "test", redaction_state: "redacted", payload: { detail: "ordinary text" } });
  drainer.drainOnce();
  assert.strictEqual(seen.redacted_by_delivery, false);
  assert.strictEqual(seen.payload.detail, "ordinary text");
});

test("a payload that declares no redaction state is redacted before delivery", () => {
  resetEvents();
  let seen = null;
  drainer.registerHandler("unknown.consumer", event => { seen = event; }, { event_type: "delivery.unstated" });
  // Omitting redaction_state used to record "redacted", which let a publisher
  // that redacted nothing opt its payload out of the delivery redaction pass.
  const stored = kernel.appendEvent({ event_type: "delivery.unstated", source: "test", payload: { error: "token sk-live-abcdef" } });
  assert.strictEqual(stored.redaction_state, "unknown", "an undeclared payload is not assumed redacted");
  drainer.drainOnce();
  assert.strictEqual(seen.redacted_by_delivery, true);
  assert.ok(!JSON.stringify(seen.payload).includes("sk-live-abcdef"), "delivery redacts what the publisher did not");
});

// ---- sensitivity (B5 residual) ----------------------------------------------

test("sensitivity is a closed set and defaults to normal", () => {
  resetEvents();
  assert.strictEqual(kernel.appendEvent({ event_type: "delivery.test", source: "test" }).sensitivity, "normal");
  assert.strictEqual(kernel.appendEvent({ event_type: "delivery.test", source: "test", sensitivity: "secret" }).sensitivity, "secret");
  assert.throws(() => kernel.appendEvent({ event_type: "delivery.test", source: "test", sensitivity: "kinda-secret" }), /sensitivity must be one of/);
});

test("fan-out withholds events above a subscription's sensitivity ceiling", () => {
  resetEvents();
  drainer.registerHandler("normal.consumer", () => {}, { event_type: "delivery.graded" });
  drainer.registerHandler("cleared.consumer", () => {}, { event_type: "delivery.graded", max_sensitivity: "secret" });

  kernel.appendEvent({ event_type: "delivery.graded", source: "test", sensitivity: "secret" });
  const delivered = kernel.listEventDeliveries({ limit: 100 });
  assert.strictEqual(delivered.length, 1, "only the cleared subscription is addressed");
  assert.strictEqual(delivered[0].subscription_name, "cleared.consumer");

  // Gating at fan-out means no row exists to leak later via requeue or the UI.
  kernel.appendEvent({ event_type: "delivery.graded", source: "test" });
  assert.strictEqual(kernel.listEventDeliveries({ limit: 100 }).length, 3, "a normal event reaches both");
});

// ---- provenance (B5 residual) -----------------------------------------------

test("event source shape is enforced and unknown sources are flagged, not dropped", () => {
  resetEvents();
  assert.throws(() => kernel.appendEvent({ event_type: "delivery.test", source: "Bad Source!" }), /event source must be lowercase/);
  assert.throws(() => kernel.appendEvent({ event_type: "delivery.test", source: "UPPER" }), /event source must be lowercase/);
  // A missing or empty source keeps its long-standing default rather than
  // failing a publisher that never set one.
  assert.strictEqual(kernel.appendEvent({ event_type: "delivery.test", source: "" }).source, "platform");
  assert.strictEqual(kernel.appendEvent({ event_type: "delivery.test" }).source, "platform");

  // Unknown but well-formed is allowed on purpose: nearly every production
  // publisher swallows appendEvent errors, so rejecting would silently drop the
  // event rather than record it with odd provenance.
  const event = kernel.appendEvent({ event_type: "delivery.test", source: "brand-new-subsystem" });
  assert.strictEqual(event.source, "brand-new-subsystem");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
