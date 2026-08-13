"use strict";

/**
 * Platform event delivery drainer and handler registry.
 *
 * The delivery contract (migration 030) shipped complete on paper — durable
 * subscriptions, attempts, retry/dead-letter, consumer offsets — and completely
 * inert in practice: `deliverEvent` had no caller outside the kernel and its
 * own test, nothing polled `pending`/`retry`, and the offsets table was written
 * but never read. Publishing worked, so the gap was invisible; every event
 * queued for a subscription simply sat there.
 *
 * This module is the missing half. It is deliberately small:
 *
 *   - A HANDLER REGISTRY keyed by subscription NAME, not id. Names are stable
 *     across databases and re-registration; ids are not, so a handler bound to
 *     an id would silently stop matching after any environment rebuild.
 *   - A POLL LOOP that claims due deliveries and runs their handler. Claiming
 *     is an atomic conditional UPDATE in the kernel, so running two drainers is
 *     safe (the loser gets null) — it is wasteful, not incorrect.
 *   - A STALE-CLAIM PASS. Introducing a consumer introduces a way to die
 *     holding a claim; a delivery stuck `in_flight` after a crash would never
 *     be retried without this.
 *
 * What it deliberately does NOT do:
 *
 *   - It does not ack deliveries for subscriptions with no registered handler.
 *     Acking would mark an event delivered that nothing consumed. They stay
 *     `pending`, are reported as `skipped_no_handler`, and the kernel's backlog
 *     cap eventually pauses the subscription. Bounded and visible beats silent.
 *   - It does not deliver to external systems. Handlers here are in-process and
 *     side-effect-light on purpose; a webhook fan-out belongs behind the
 *     connector authority, not inside the drainer.
 */

const { redactSensitive } = require("../redact");
const kernel = require("./kernel");

// subscription name -> handler(event)
const handlers = new Map();

const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_STALE_CLAIM_MS = 300000;

function getDrainIntervalMs() {
  const configured = parseInt(process.env.SIDEKICK_EVENT_DRAIN_INTERVAL_MS || "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_INTERVAL_MS;
  // Floor at 1s so a misconfiguration cannot spin the loop; ceiling at 5min so
  // the delay between an event and its consumer stays defensible.
  return Math.min(Math.max(configured, 1000), 300000);
}

function getBatchLimit() {
  const configured = parseInt(process.env.SIDEKICK_EVENT_DRAIN_BATCH || "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_BATCH_LIMIT;
  return Math.min(Math.max(configured, 1), 500);
}

/**
 * Binds a handler to a subscription name and makes sure the subscription
 * exists. Idempotent: re-registering the same name replaces the handler and
 * reuses the stored subscription, including its state — a subscription an
 * operator paused (or that the backlog cap auto-paused) stays paused until the
 * operator resumes it. Restarting the process must not silently undo that.
 */
function registerHandler(name, handler, { event_type = null, max_attempts = 3 } = {}) {
  const subscriptionName = String(name || "").trim();
  if (!subscriptionName) throw new Error("handler subscription name is required");
  if (typeof handler !== "function") throw new Error("handler must be a function");

  const existing = kernel.listEventSubscriptions().find(s => s.name === subscriptionName);
  let subscription = existing;
  if (!subscription) {
    if (!event_type) throw new Error(`event_type is required to create subscription ${subscriptionName}`);
    subscription = kernel.registerEventSubscription({ name: subscriptionName, event_type, max_attempts });
  } else if (event_type && existing.event_type !== event_type) {
    // The stored subscription is the authority for what it matches. Rebinding
    // the type here would change fan-out for a queue that already has rows in
    // it, so this is reported rather than applied.
    console.error(JSON.stringify({
      level: "warn",
      event: "platform.event.handler_type_mismatch",
      subscription_name: subscriptionName,
      registered_event_type: existing.event_type,
      requested_event_type: event_type,
    }));
  }
  handlers.set(subscriptionName, handler);
  return subscription;
}

function unregisterHandler(name) {
  return handlers.delete(String(name || "").trim());
}

function listHandlers() {
  return Array.from(handlers.keys()).sort();
}

function clearHandlers() {
  handlers.clear();
}

/**
 * One drain pass. Never throws for an ordinary condition: a handler that throws
 * is a failed delivery (retried, then dead-lettered by the kernel), not a
 * reason to stop draining everything else.
 */
function drainOnce({ limit = getBatchLimit(), staleClaimMs = DEFAULT_STALE_CLAIM_MS } = {}) {
  const summary = {
    at: new Date().toISOString(),
    recovered: 0,
    claimed: 0,
    delivered: 0,
    failed: 0,
    skipped_no_handler: 0,
    errors: [],
  };

  try {
    summary.recovered = kernel.recoverStaleEventDeliveries({ olderThanMs: staleClaimMs });
  } catch (error) {
    summary.errors.push({ pass: "recover", message: redactSensitive(String(error && error.message || error)).slice(0, 200) });
  }

  let due = [];
  try {
    due = kernel.listClaimableEventDeliveries({ limit });
  } catch (error) {
    summary.errors.push({ pass: "list", message: redactSensitive(String(error && error.message || error)).slice(0, 200) });
    return summary;
  }

  for (const delivery of due) {
    const handler = handlers.get(delivery.subscription_name);
    if (!handler) {
      summary.skipped_no_handler += 1;
      continue;
    }
    try {
      const result = kernel.deliverEvent(delivery.delivery_id, handler);
      if (!result) continue; // lost the claim race, or the subscription was paused mid-pass
      summary.claimed += 1;
      if (result.status === "delivered") summary.delivered += 1;
      else summary.failed += 1;
    } catch (error) {
      // deliverEvent already converts a throwing handler into a failed
      // delivery, so reaching here means the delivery bookkeeping itself
      // failed — worth reporting, not worth abandoning the batch.
      summary.errors.push({
        pass: "deliver",
        delivery_id: delivery.delivery_id,
        message: redactSensitive(String(error && error.message || error)).slice(0, 200),
      });
    }
  }

  return summary;
}

let timer = null;

function startDrainer({ intervalMs = getDrainIntervalMs(), onDrain = null } = {}) {
  if (timer) return { started: false, reason: "already_running", intervalMs };
  timer = setInterval(() => {
    let summary;
    try {
      summary = drainOnce();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "platform.event.drain_failed",
        error: redactSensitive(String(error && error.message || error)).slice(0, 200),
      }));
      return;
    }
    const acted = summary.delivered + summary.failed + summary.recovered;
    // A quiet ledger is the normal case; logging every empty pass would bury
    // the passes that matter.
    if (acted > 0 || summary.errors.length > 0) {
      console.error(JSON.stringify({ level: summary.errors.length ? "error" : "info", event: "platform.event.drain", ...summary }));
    }
    if (onDrain) { try { onDrain(summary); } catch {} }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { started: true, intervalMs };
}

function stopDrainer() {
  if (!timer) return { stopped: false };
  clearInterval(timer);
  timer = null;
  return { stopped: true };
}

function isRunning() {
  return timer !== null;
}

/**
 * The first-party consumer.
 *
 * Scoped to failure events rather than `*` on purpose. A wildcard subscription
 * would create a delivery row and two extra writes for every event the platform
 * publishes, to tell an operator things they can already read in the ledger.
 * These four types are low-volume, are the ones worth waking up for, and give
 * the pipeline a real production consumer whose offsets actually advance.
 *
 * The handler logs and nothing else. Kernel events are already stored redacted;
 * this re-redacts on the way out because a log line is a different trust
 * boundary from a database column.
 */
const BUILTIN_CONSUMERS = Object.freeze([
  { name: "platform.execution-failures", event_type: "execution.failed" },
  { name: "platform.execution-timeouts", event_type: "execution.timed_out" },
  { name: "platform.execution-rollback-failures", event_type: "execution.rollback_failed" },
  { name: "platform.module-health-alerts", event_type: "module.health.alert" },
]);

function operationalAlertHandler(event) {
  console.error(JSON.stringify({
    level: "error",
    event: "platform.event.alert",
    event_id: event.event_id,
    event_type: event.event_type,
    severity: event.severity,
    source: event.source,
    subject_type: event.subject_type,
    subject_id: event.subject_id,
    execution_id: event.execution_id,
    project_id: event.project_id,
    timestamp: event.timestamp,
    payload: redactSensitive(JSON.stringify(event.payload || {})).slice(0, 500),
  }));
}

function registerBuiltinConsumers() {
  const registered = [];
  const errors = [];
  for (const consumer of BUILTIN_CONSUMERS) {
    try {
      registerHandler(consumer.name, operationalAlertHandler, { event_type: consumer.event_type });
      registered.push(consumer.name);
    } catch (error) {
      // One malformed consumer must not cost the others their handler.
      errors.push({ name: consumer.name, message: redactSensitive(String(error && error.message || error)).slice(0, 200) });
    }
  }
  return { registered, errors };
}

module.exports = {
  BUILTIN_CONSUMERS,
  getDrainIntervalMs,
  getBatchLimit,
  registerHandler,
  unregisterHandler,
  listHandlers,
  clearHandlers,
  drainOnce,
  startDrainer,
  stopDrainer,
  isRunning,
  registerBuiltinConsumers,
  operationalAlertHandler,
};
