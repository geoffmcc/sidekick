const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dbStore = require("../db");
const { AsyncLocalStorage } = require("async_hooks");
const eventVocabulary = require("./event-vocabulary");
const { createExecutionGuards } = require("./execution-guards");
const { createConnectorStore } = require("./connectors");
const { createArtifactStore } = require("./artifacts");
const { redactSensitive, redactSensitiveKeysDeep } = require("../redact");
const { KERNEL_SCHEMA_SQL } = require("./kernel-schema");
const { ensurePlatformModuleSchema } = require("../modules/schema");
const { ensureCapabilityPackSchema } = require("./capability-pack-schema");
const { ensureWorkflowDefinitionSchema } = require("../workflows/schema");
const { encryptColumn, decryptColumn, hasSecretKey } = require("../core/secret-cipher");
const { canonicalizeProjectName } = require("../core/project-identity");
const { canSupportAuthoritativeCompletion, normalizeEvidenceMetadata } = require("../evidence/classes");

const EXECUTION_STATES = Object.freeze([
  "created",
  "planned",
  "queued",
  "awaiting_approval",
  "ready",
  "running",
  "waiting",
  "blocked",
  "retrying",
  "verifying",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "timed_out",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
  "orphaned",
]);

const TERMINAL_STATES = new Set(["completed", "partial", "failed", "cancelled", "timed_out", "rolled_back", "rollback_failed"]);

const ALLOWED_TRANSITIONS = Object.freeze({
  created: ["planned", "queued", "awaiting_approval", "ready", "running", "cancelled", "failed"],
  planned: ["queued", "awaiting_approval", "ready", "blocked", "cancelled", "failed"],
  queued: ["awaiting_approval", "ready", "running", "blocked", "cancelled", "timed_out", "orphaned"],
  awaiting_approval: ["ready", "blocked", "cancelled", "timed_out", "failed", "completed"],
  ready: ["running", "blocked", "cancelled", "timed_out", "failed"],
  running: ["waiting", "retrying", "verifying", "completed", "partial", "failed", "cancelled", "timed_out", "rolling_back", "orphaned", "awaiting_approval"],
  waiting: ["running", "blocked", "cancelled", "timed_out", "orphaned"],
  blocked: ["planned", "queued", "ready", "cancelled", "failed"],
  retrying: ["queued", "running", "failed", "cancelled", "timed_out"],
  verifying: ["completed", "partial", "failed", "rolling_back", "rollback_failed"],
  rolling_back: ["rolled_back", "rollback_failed", "failed"],
  orphaned: ["queued", "running", "failed", "cancelled"],
});

const PROJECT_STATES = Object.freeze(["active", "archived"]);

const PROJECT_SOURCE_TYPES = Object.freeze([
  "kv",
  "memory",
  "agent",
  "compute",
  "workspace",
  "execution",
  "handoff",
  "session",
  "predict",
  "blackbox",
  "custom",
]);

function nowIso() {
  return new Date().toISOString();
}

/**
 * ISO timestamp `hours` in the past, for use as a bound parameter.
 *
 * Timestamp columns store ISO 8601 ("2026-07-19T21:34:49.497Z"). SQLite's
 * datetime() returns a space-separated string ("2026-07-19 21:34:49"), so
 * comparing a column against datetime('now', ...) compares 'T' (0x54) against
 * ' ' (0x20) and every ISO row sorts above the bound. Always bind an ISO value.
 */
function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function json(value) {
  return JSON.stringify(value || {});
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeProjectId(projectId) {
  if (typeof projectId !== "string") throw new Error("project_id must be a non-empty string");
  // Canonicalize (lowercase + charset) so casing/charset variants of the same
  // project resolve to one identity across every registry writer. The FK from
  // platform_project_sources depends on this being the single canonical form.
  const id = canonicalizeProjectName(projectId);
  if (!id) throw new Error("project_id must be a non-empty string");
  return id;
}

function normalizeProject(row) {
  if (!row) return null;
  return { ...row, metadata: parseJson(row.metadata_json, {}) };
}

function normalizeProjectSource(row) {
  if (!row) return null;
  return { ...row, metadata: parseJson(row.metadata_json, {}) };
}

function normalizeArtifact(row) {
  if (!row) return null;
  const lineage = parseJson(row.lineage_json, {});
  return {
    ...row,
    lineage,
    verification: parseJson(row.verification_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    custody_role: lineage.role || (row.supersedes_artifact_id ? "derivative" : "original"),
  };
}

function normalizeWorkspace(row, secretNames = []) {
  if (!row) return null;
  // secrets_json never leaves the kernel: legacy plaintext is only reachable
  // through backfillWorkspaceSecrets, and current values only through
  // getWorkspaceSecret.
  const { secrets_json, ...rest } = row;
  return {
    ...rest,
    config: parseJson(row.config_json, {}),
    resource_limits: parseJson(row.resource_limits_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    secret_names: secretNames,
  };
}

function getWorkspaceSecretNames(workspaceId) {
  const rows = dbStore.getDb().prepare("SELECT secret_name FROM platform_workspace_secrets WHERE workspace_id = ? ORDER BY secret_name").all(workspaceId);
  return rows.map((r) => r.secret_name);
}

function ensurePlatformKernelSchema() {
  const db = dbStore.getDb();
  db.exec(KERNEL_SCHEMA_SQL);
  for (const [table, column] of [
    ["platform_executions", "requested_by_principal_id"],
    ["platform_executions", "actor_principal_id"],
    ["platform_executions", "acting_for_principal_id"],
    ["platform_executions", "executed_by_principal_id"],
    ["platform_workflows", "requested_by_principal_id"],
    ["platform_workflows", "actor_principal_id"],
    ["platform_workflows", "acting_for_principal_id"],
    ["platform_workflows", "executed_by_principal_id"],
    ["platform_runner_sessions", "requested_by_principal_id"],
    ["platform_runner_sessions", "actor_principal_id"],
    ["platform_runner_sessions", "acting_for_principal_id"],
    ["platform_runner_sessions", "executed_by_principal_id"],
    ["platform_artifacts", "owner_principal_id"],
    ["platform_artifacts", "created_by_principal_id"],
  ]) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_platform_executions_actor_principal ON platform_executions(actor_principal_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_platform_workflows_actor_principal ON platform_workflows(actor_principal_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_platform_runner_sessions_actor_principal ON platform_runner_sessions(actor_principal_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_platform_artifacts_owner_principal ON platform_artifacts(owner_principal_id)");
  ensurePlatformModuleSchema();
  ensureCapabilityPackSchema();
  ensureWorkflowDefinitionSchema();
}

function assertState(state) {
  if (!EXECUTION_STATES.includes(state)) throw new Error(`Invalid execution state: ${state}`);
}

function validateTransition(from, to) {
  assertState(to);
  if (!from) return to === "created";
  assertState(from);
  if (from === to) return true;
  if (TERMINAL_STATES.has(from)) return false;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function normalizeExecution(row) {
  if (!row) return null;
  return {
    execution_id: row.execution_id,
    parent_execution_id: row.parent_execution_id,
    root_execution_id: row.root_execution_id,
    task_id: row.task_id,
    session_id: row.session_id,
    workflow_id: row.workflow_id,
    project_id: row.project_id,
    incident_id: row.incident_id,
    change_set_id: row.change_set_id,
    actor_id: row.actor_id,
    requested_by_principal_id: row.requested_by_principal_id || null,
    actor_principal_id: row.actor_principal_id || null,
    acting_for_principal_id: row.acting_for_principal_id || null,
    executed_by_principal_id: row.executed_by_principal_id || null,
    client_id: row.client_id,
    trigger_type: row.trigger_type,
    operation_type: row.operation_type,
    tool_name: row.tool_name,
    tool_action: row.tool_action,
    resource_scope: row.resource_scope,
    environment: row.environment,
    state: row.state,
    risk: row.risk,
    approval_state: row.approval_state,
    started_at: row.started_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    deadline_at: row.deadline_at,
    heartbeat_at: row.heartbeat_at,
    result_status: row.result_status,
    error_category: row.error_category,
    result_summary: row.result_summary,
    artifact_count: row.artifact_count,
    trace_id: row.trace_id,
    span_id: row.span_id,
    schema_version: row.schema_version,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function createExecution(input = {}) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const ts = input.created_at || nowIso();
  const executionId = input.execution_id || newId("exec");
  const rootId = input.root_execution_id || input.parent_execution_id || executionId;
  const state = input.state || "created";
  const project = input.project_id
    ? registerProject({ project_id: input.project_id, owner_actor_id: input.actor_id, source: input.source || "platform" })
    : null;
  const projectId = project ? project.project_id : null;
  if (!validateTransition(null, state)) throw new Error(`Execution must start in created state, got ${state}`);
  db.prepare(`
    INSERT INTO platform_executions (
      execution_id, parent_execution_id, root_execution_id, task_id, session_id, workflow_id,
      project_id, incident_id, change_set_id, actor_id, requested_by_principal_id, actor_principal_id,
      acting_for_principal_id, executed_by_principal_id, client_id, trigger_type, operation_type,
      tool_name, tool_action, resource_scope, environment, state, risk, approval_state, started_at,
      updated_at, deadline_at, heartbeat_at, trace_id, span_id, schema_version, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    executionId,
    input.parent_execution_id || null,
    rootId,
    input.task_id || null,
    input.session_id || null,
    input.workflow_id || null,
    projectId,
    input.incident_id || null,
    input.change_set_id || null,
    input.actor_id || null,
    input.requested_by_principal_id || null,
    input.actor_principal_id || null,
    input.acting_for_principal_id || null,
    input.executed_by_principal_id || null,
    input.client_id || null,
    input.trigger_type || null,
    input.operation_type || "operation",
    input.tool_name || null,
    input.tool_action || null,
    input.resource_scope || null,
    input.environment || null,
    state,
    input.risk || "unknown",
    input.approval_state || "not_required",
    input.started_at || null,
    ts,
    input.deadline_at || null,
    input.heartbeat_at || null,
    input.trace_id || rootId,
    input.span_id || executionId,
    json(input.metadata || {})
  );
  db.prepare(`INSERT INTO platform_execution_transitions (execution_id, previous_state, new_state, actor_id, reason, created_at) VALUES (?, NULL, ?, ?, ?, ?)`)
    .run(executionId, state, input.actor_id || null, input.reason || "execution created", ts);
  appendEvent({
    event_type: "execution.created",
    source: input.source || "platform",
    actor_id: input.actor_id,
    execution_id: executionId,
    root_execution_id: rootId,
    task_id: input.task_id,
    session_id: input.session_id,
    project_id: projectId,
    environment: input.environment,
    payload: { state, operation_type: input.operation_type || "operation", tool_name: input.tool_name || null },
    correlation_id: input.correlation_id || rootId,
  });
  return getExecution(executionId);
}

function getExecution(executionId) {
  ensurePlatformKernelSchema();
  return normalizeExecution(dbStore.getDb().prepare("SELECT * FROM platform_executions WHERE execution_id = ?").get(executionId));
}

function transitionExecution(executionId, newState, details = {}) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const current = getExecution(executionId);
  if (!current) throw new Error(`Execution not found: ${executionId}`);
  if (!validateTransition(current.state, newState)) throw new Error(`Invalid execution transition: ${current.state} -> ${newState}`);
  const ts = details.timestamp || nowIso();
  const completedAt = TERMINAL_STATES.has(newState) ? (details.completed_at || ts) : null;
  db.prepare(`
    UPDATE platform_executions
    SET state = ?, updated_at = ?, completed_at = COALESCE(?, completed_at), result_status = COALESCE(?, result_status),
        error_category = COALESCE(?, error_category), result_summary = COALESCE(?, result_summary), heartbeat_at = COALESCE(?, heartbeat_at)
    WHERE execution_id = ?
  `).run(newState, ts, completedAt, details.result_status || null, details.error_category || null, details.result_summary ? redactSensitive(details.result_summary) : null, details.heartbeat_at || null, executionId);
  // The previous transition's event is this one's cause: a state change follows
  // from the change before it. `platform_execution_transitions` already records
  // the event id per transition, so the chain is derivable without new schema —
  // it was simply never read back.
  const previousTransition = db.prepare(
    "SELECT event_id FROM platform_execution_transitions WHERE execution_id = ? AND event_id IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).get(executionId);
  const event = appendEvent({
    event_type: `execution.${newState}`,
    causation_id: details.causation_id || previousTransition?.event_id || null,
    source: details.source || "platform",
    actor_id: details.actor_id || current.actor_id,
    execution_id: executionId,
    root_execution_id: current.root_execution_id,
    task_id: current.task_id,
    session_id: current.session_id,
    project_id: current.project_id,
    environment: current.environment,
    severity: ["failed", "rollback_failed", "timed_out"].includes(newState) ? "error" : "info",
    payload: { previous_state: current.state, new_state: newState, reason: details.reason || null },
    correlation_id: details.correlation_id || current.root_execution_id,
  });
  db.prepare(`INSERT INTO platform_execution_transitions (execution_id, previous_state, new_state, actor_id, reason, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(executionId, current.state, newState, details.actor_id || current.actor_id || null, details.reason || null, event.event_id, ts);
  return getExecution(executionId);
}

/**
 * Ambient causation. `causation_id` existed in the schema from the start and no
 * publisher ever set it, so the ledger recorded *that* things happened and
 * never *what caused* them — correlation grouped a chain, but the parentage
 * inside it was lost.
 *
 * The textbook case only became real when B5 shipped a consumer: an event
 * published while handling another event is caused by it. Threading that
 * through every handler signature would be invasive and easy to forget, so the
 * drainer establishes it as context instead and `appendEvent` picks it up.
 * AsyncLocalStorage rather than a module-level variable because a handler may
 * be async, and a plain variable would leak one delivery's causation into a
 * concurrently-running one.
 *
 * An explicit `causation_id` on the input always wins over the ambient value.
 */
/**
 * Provenance validation, NOT authorization. It rejects a malformed `source` and
 * flags one that no known producer uses; it cannot tell whether the caller is
 * entitled to claim that source, because in single-operator mode there is no
 * durable actor identity to check against (see docs/platform-events.md).
 *
 * Unknown-but-well-formed sources are allowed for the same reason unknown
 * namespaces are: nearly every production publisher wraps `appendEvent` in a
 * swallowed try/catch, so rejecting would silently drop the event — strictly
 * worse than recording it with odd provenance. The set has already drifted on
 * its own (`approval` vs `approvals`), which is what the warning surfaces.
 */
const warnedUnknownSources = new Set();

function normalizeEventSource(value) {
  const source = String(value || "").trim();
  if (!eventVocabulary.isValidSourceShape(source)) {
    throw new Error(`event source must be lowercase alphanumeric with - or _ separators, got: ${JSON.stringify(source).slice(0, 64)}`);
  }
  if (!eventVocabulary.isKnownSource(source) && !warnedUnknownSources.has(source)) {
    // Once per process per source: a new publisher should be visible, but not
    // at one log line per event.
    warnedUnknownSources.add(source);
    console.error(JSON.stringify({ level: "warn", event: "platform.event.unknown_source", source }));
  }
  return source;
}

function normalizeEventSensitivity(value) {
  if (value === undefined || value === null || value === "") return "normal";
  const sensitivity = String(value);
  if (!eventVocabulary.isValidSensitivity(sensitivity)) {
    throw new Error(`event sensitivity must be one of ${eventVocabulary.SENSITIVITY_LEVELS.join(", ")}, got: ${JSON.stringify(sensitivity).slice(0, 32)}`);
  }
  return sensitivity;
}

const causationContext = new AsyncLocalStorage();

function runWithCausation(eventId, fn) {
  if (!eventId) return fn();
  return causationContext.run({ eventId: String(eventId) }, fn);
}

function getAmbientCausationId() {
  return causationContext.getStore()?.eventId || null;
}

function appendEvent(input = {}) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const eventId = input.event_id || newId("evt");
  const payload = input.payload || {};
  const ts = input.timestamp || nowIso();
  const source = normalizeEventSource(input.source || "platform");
  const sensitivity = normalizeEventSensitivity(input.sensitivity);
  const causationId = input.causation_id || getAmbientCausationId();
  // Canonicalize through the same choke point as the registry writers so a
  // casing/charset variant of a project id never forks the event ledger's
  // identity space. Null/empty stays null (events are not required to carry a
  // project).
  const projectId = input.project_id == null || input.project_id === "" ? null : normalizeProjectId(input.project_id);
  const insertEvent = db.prepare(`
    INSERT INTO platform_execution_events (
      event_id, event_type, schema_version, timestamp, source, actor_id, subject_type, subject_id,
      project_id, environment, execution_id, root_execution_id, task_id, session_id, severity,
      payload_json, sensitivity, dedupe_key, causation_id, correlation_id, redaction_state
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    // The append and its fan-out are ONE transaction. Enqueue used to run after
    // the insert committed, inside `try {} catch {}`: a crash or an error in
    // between produced an event that is in the ledger, is not in any
    // subscription's delivery queue, and that no consumer can ever discover is
    // missing. Either both land or neither does.
    db.transaction(() => {
      insertEvent.run(
        eventId,
        input.event_type,
        ts,
        source,
        input.actor_id || null,
        input.subject_type || null,
        input.subject_id || null,
        projectId,
        input.environment || null,
        input.execution_id || null,
        input.root_execution_id || null,
        input.task_id || null,
        input.session_id || null,
        input.severity || "info",
        json(payload),
        sensitivity,
        input.dedupe_key || null,
        causationId,
        input.correlation_id || input.root_execution_id || input.execution_id || null,
        // Default to "unknown", not "redacted". Delivery skips its own
        // redaction pass for anything already labeled redacted, so defaulting
        // to that label let a publisher that never redacted anything opt its
        // payload out of redaction just by not saying so. Publishers that do
        // redact still declare it explicitly.
        input.redaction_state || "unknown"
      );
      enqueueDeliveriesForEvent(db, { event_id: eventId, event_type: input.event_type, sensitivity });
    })();
  } catch (error) {
    if (input.dedupe_key && /UNIQUE constraint failed/.test(error.message)) {
      return db.prepare("SELECT * FROM platform_execution_events WHERE dedupe_key = ?").get(input.dedupe_key);
    }
    throw error;
  }
  return db.prepare("SELECT * FROM platform_execution_events WHERE event_id = ?").get(eventId);
}

function normalizeEventSubscription(row) {
  if (!row) return null;
  return { ...row, metadata: parseJson(row.metadata_json, {}) };
}

function normalizeEventDelivery(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function registerEventSubscription(input = {}) {
  ensurePlatformKernelSchema();
  const name = String(input.name || "").trim();
  const eventType = String(input.event_type || "").trim();
  if (!name) throw new Error("subscription name is required");
  if (!eventType) throw new Error("subscription event_type is required");
  // Fan-out is exact-match, so a typo produces a subscription that silently
  // never fires. Shape is enforced; an unrecognised namespace is reported and
  // logged but allowed, because a new subsystem must not be blocked from
  // subscribing before someone edits the vocabulary. See event-vocabulary.js.
  const typeCheck = eventVocabulary.validateSubscriptionEventType(eventType);
  if (!typeCheck.valid) throw new Error(typeCheck.reason);
  if (typeCheck.unknown_namespace) {
    console.error(JSON.stringify({
      level: "warn",
      event: "platform.event.subscription_unknown_namespace",
      subscription_name: name,
      event_type: eventType,
      namespace: eventVocabulary.getEventNamespace(eventType),
    }));
  }
  const maxAttempts = Number.isInteger(input.max_attempts) ? input.max_attempts : 3;
  if (maxAttempts < 1 || maxAttempts > 20) throw new Error("max_attempts must be between 1 and 20");
  const subscriptionId = input.subscription_id || newId("sub");
  const ts = nowIso();
  dbStore.getDb().prepare(`
    INSERT INTO platform_event_subscriptions
      (subscription_id, name, event_type, state, max_attempts, created_at, updated_at, metadata_json)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(subscriptionId, name, eventType, maxAttempts, ts, ts, json({
    ...(input.metadata || {}),
    ...(typeCheck.unknown_namespace ? { unknown_namespace: true } : {}),
  }));
  dbStore.getDb().prepare(`
    INSERT INTO platform_event_offsets (subscription_id, last_event_rowid, updated_at)
    VALUES (?, 0, ?)
  `).run(subscriptionId, ts);
  return normalizeEventSubscription(dbStore.getDb().prepare("SELECT * FROM platform_event_subscriptions WHERE subscription_id = ?").get(subscriptionId));
}

function setEventSubscriptionState(subscriptionId, state) {
  ensurePlatformKernelSchema();
  if (!["active", "paused"].includes(state)) throw new Error("subscription state must be active or paused");
  const result = dbStore.getDb().prepare("UPDATE platform_event_subscriptions SET state = ?, updated_at = ? WHERE subscription_id = ?").run(state, nowIso(), String(subscriptionId));
  if (!result.changes) throw new Error(`Event subscription not found: ${subscriptionId}`);
  return normalizeEventSubscription(dbStore.getDb().prepare("SELECT * FROM platform_event_subscriptions WHERE subscription_id = ?").get(String(subscriptionId)));
}

function listEventSubscriptions() {
  ensurePlatformKernelSchema();
  return dbStore.getDb().prepare("SELECT * FROM platform_event_subscriptions ORDER BY created_at DESC").all().map(normalizeEventSubscription);
}

const DEFAULT_EVENT_BACKLOG_CAP = 10000;

function getEventBacklogCap() {
  const configured = parseInt(process.env.SIDEKICK_EVENT_BACKLOG_CAP || "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_EVENT_BACKLOG_CAP;
  // Floor at 10 so a misconfiguration cannot pause every subscription on the
  // first event; ceiling high enough that the cap stays a safety net rather
  // than a queue-depth policy.
  return Math.min(Math.max(configured, 10), 1_000_000);
}

/**
 * Bounded backlog probe. Counting the full undelivered set on every publish
 * would make a subscription that is millions behind expensive exactly when it
 * is already unhealthy, so the subquery stops at cap + 1 — enough to answer
 * "at or over the cap?" and nothing more.
 */
function countUndeliveredDeliveries(db, subscriptionId, cap) {
  return db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM platform_event_deliveries
      WHERE subscription_id = ? AND status IN ('pending', 'retry', 'in_flight')
      LIMIT ?
    )
  `).get(String(subscriptionId), cap + 1).count;
}

/**
 * Fan-out for one event. Runs inside the caller's transaction (see appendEvent)
 * and must therefore never throw for an ordinary condition: a slow or absent
 * consumer is not a reason to fail the publisher.
 */
function enqueueDeliveriesForEvent(db, event) {
  const subscriptions = db.prepare("SELECT * FROM platform_event_subscriptions WHERE state = 'active' AND (event_type = ? OR event_type = '*')").all(event.event_type);
  if (!subscriptions.length) return 0;
  const cap = getEventBacklogCap();
  const ts = nowIso();
  const eventSensitivity = event.sensitivity || "normal";
  let queued = 0;
  for (const subscription of subscriptions) {
    // Sensitivity ceiling, declared per subscription and defaulting to `normal`.
    // Gating at FAN-OUT rather than at delivery is the stricter choice: an event
    // a subscription may not see never becomes a row addressed to it, so it
    // cannot leak through a later handler change, a requeue, or the dashboard's
    // delivery list. Every event in the production ledger is `normal` today, so
    // this gate is inert until a publisher raises one — it is a policy hook, not
    // a claim that anything is currently being withheld.
    const maxSensitivity = parseJson(subscription.metadata_json, {}).max_sensitivity || "normal";
    if (!eventVocabulary.sensitivityAllowed(eventSensitivity, maxSensitivity)) continue;
    if (countUndeliveredDeliveries(db, subscription.subscription_id, cap) >= cap) {
      // Auto-pause at the cap. This is the fix for the operational hazard that
      // POST /api/event-subscriptions created: a subscription nothing drains
      // used to accumulate `pending` rows without bound. Pausing stops the
      // growth at the source, is durable, and is visible in the subscription
      // list — unlike dropping the delivery, which would lose the event with no
      // record, and unlike failing the publish, which would let a dead consumer
      // take down every producer. The operator drains or requeues, then calls
      // setEventSubscriptionState to resume; events published while paused are
      // not delivered, which is what paused means.
      const metadata = parseJson(subscription.metadata_json, {});
      metadata.auto_paused_at = ts;
      metadata.auto_pause_reason = `backlog cap of ${cap} undelivered deliveries reached`;
      db.prepare("UPDATE platform_event_subscriptions SET state = 'paused', updated_at = ?, metadata_json = ? WHERE subscription_id = ? AND state = 'active'")
        .run(ts, json(metadata), subscription.subscription_id);
      continue;
    }
    const result = db.prepare(`
      INSERT OR IGNORE INTO platform_event_deliveries
        (delivery_id, subscription_id, event_id, status, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, 'pending', ?, ?, '{}')
    `).run(newId("delivery"), subscription.subscription_id, event.event_id, ts, ts);
    queued += result.changes;
  }
  return queued;
}

function enqueueEventDeliveries(eventId) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const event = db.prepare("SELECT event_id, event_type, sensitivity FROM platform_execution_events WHERE event_id = ?").get(eventId);
  if (!event) return 0;
  return db.transaction(() => enqueueDeliveriesForEvent(db, event))();
}

/**
 * Work query for the drainer: deliveries that are due now, for subscriptions
 * that are still active. Claiming is a separate atomic step
 * (`claimEventDelivery`), so two drainers racing on the same row is safe — the
 * loser simply gets null.
 */
function listClaimableEventDeliveries({ limit = 50, subscription_ids = null } = {}) {
  ensurePlatformKernelSchema();
  const now = nowIso();
  const bounded = Math.max(1, Math.min(Number(limit) || 50, 500));
  const params = [now];
  let filter = "";
  if (Array.isArray(subscription_ids) && subscription_ids.length) {
    filter = ` AND d.subscription_id IN (${subscription_ids.map(() => "?").join(",")})`;
    params.push(...subscription_ids.map(String));
  }
  return dbStore.getDb().prepare(`
    SELECT d.delivery_id, d.subscription_id, d.event_id, d.attempt_count, s.name AS subscription_name, s.event_type, s.max_attempts
    FROM platform_event_deliveries d
    JOIN platform_event_subscriptions s ON s.subscription_id = d.subscription_id
    WHERE d.status IN ('pending', 'retry')
      AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
      AND s.state = 'active'${filter}
    ORDER BY d.created_at ASC, d.rowid ASC
    LIMIT ?
  `).all(...params, bounded).map(normalizeEventDelivery);
}

/**
 * Reclaims deliveries stuck `in_flight`. A handler that crashed the process
 * mid-delivery leaves its row claimed forever, and before there was a drainer
 * nothing ever claimed, so this failure mode did not exist to be handled. It
 * does now.
 *
 * `attempt_count` was already incremented at claim time, so a reclaimed
 * delivery that has exhausted its attempts goes straight to dead_letter rather
 * than being retried past `max_attempts`.
 */
function recoverStaleEventDeliveries({ olderThanMs = 300000 } = {}) {
  ensurePlatformKernelSchema();
  const cutoff = new Date(Date.now() - Math.max(1000, Number(olderThanMs) || 300000)).toISOString();
  const ts = nowIso();
  const result = dbStore.getDb().prepare(`
    UPDATE platform_event_deliveries
    SET status = CASE
          WHEN attempt_count >= (SELECT s.max_attempts FROM platform_event_subscriptions s WHERE s.subscription_id = platform_event_deliveries.subscription_id)
          THEN 'dead_letter' ELSE 'retry' END,
        next_attempt_at = NULL,
        last_error = 'reclaimed after stale in-flight delivery',
        updated_at = ?
    WHERE status = 'in_flight' AND updated_at <= ?
  `).run(ts, cutoff);
  return result.changes;
}

function claimEventDelivery(deliveryId) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const now = nowIso();
  const result = db.prepare(`
    UPDATE platform_event_deliveries
    SET status = 'in_flight', attempt_count = attempt_count + 1, updated_at = ?
    WHERE delivery_id = ?
      AND status IN ('pending', 'retry')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      AND subscription_id IN (SELECT subscription_id FROM platform_event_subscriptions WHERE state = 'active')
  `).run(now, String(deliveryId), now);
  if (!result.changes) return null;
  return normalizeEventDelivery(db.prepare(`
    SELECT d.*, s.name AS subscription_name, s.event_type, s.max_attempts
    FROM platform_event_deliveries d
    JOIN platform_event_subscriptions s ON s.subscription_id = d.subscription_id
    WHERE d.delivery_id = ?
  `).get(String(deliveryId)));
}

function completeEventDelivery(deliveryId, { ok = true, error = null } = {}) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const delivery = db.prepare(`
    SELECT d.*, s.max_attempts
    FROM platform_event_deliveries d
    JOIN platform_event_subscriptions s ON s.subscription_id = d.subscription_id
    WHERE d.delivery_id = ?
  `).get(String(deliveryId));
  if (!delivery) throw new Error(`Event delivery not found: ${deliveryId}`);
  if (delivery.status !== "in_flight") throw new Error(`Event delivery is not in flight: ${delivery.status}`);
  const ts = nowIso();
  if (ok) {
    const event = db.prepare("SELECT rowid, event_id FROM platform_execution_events WHERE event_id = ?").get(delivery.event_id);
    db.transaction(() => {
      db.prepare("UPDATE platform_event_deliveries SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL WHERE delivery_id = ?").run(ts, ts, delivery.delivery_id);
      db.prepare(`
        INSERT INTO platform_event_offsets (subscription_id, last_event_id, last_event_rowid, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET last_event_id = excluded.last_event_id, last_event_rowid = excluded.last_event_rowid, updated_at = excluded.updated_at
          WHERE excluded.last_event_rowid > platform_event_offsets.last_event_rowid
      `).run(delivery.subscription_id, event.event_id, event.rowid, ts);
    })();
  } else {
    const exhausted = delivery.attempt_count >= delivery.max_attempts;
    const nextAttempt = exhausted ? null : new Date(Date.now() + Math.min(60 * 60 * 1000, 1000 * (2 ** Math.max(0, delivery.attempt_count - 1)))).toISOString();
    db.prepare(`
      UPDATE platform_event_deliveries
      SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE delivery_id = ?
    `).run(exhausted ? "dead_letter" : "retry", nextAttempt, String(error || "delivery failed").replace(/\s+/g, " ").slice(0, 500), ts, delivery.delivery_id);
  }
  return normalizeEventDelivery(db.prepare("SELECT * FROM platform_event_deliveries WHERE delivery_id = ?").get(delivery.delivery_id));
}

function requeueEventDelivery(deliveryId) {
  ensurePlatformKernelSchema();
  const result = dbStore.getDb().prepare(`
    UPDATE platform_event_deliveries
    SET status = 'pending', attempt_count = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ?
    WHERE delivery_id = ? AND status = 'dead_letter'
  `).run(nowIso(), String(deliveryId));
  if (!result.changes) throw new Error("Only dead-lettered deliveries can be requeued");
  return normalizeEventDelivery(dbStore.getDb().prepare("SELECT * FROM platform_event_deliveries WHERE delivery_id = ?").get(String(deliveryId)));
}

/**
 * Prepares the event object handed to a handler.
 *
 * 44% of the production ledger is stored with `redaction_state: "none"` — module
 * transitions and pack events deliberately keep arbitrary error text and label
 * themselves honestly. That was safe while nothing consumed events. A consumer
 * changes the trust boundary: the payload now leaves the database and reaches
 * handler code (and, for the built-in consumers, a log line).
 *
 * So delivery redacts anything not already stored redacted, and says so on the
 * object. A subscription that genuinely needs raw text opts in with
 * `metadata.accepts_unredacted`, which is a deliberate, visible, per-subscription
 * decision rather than the default.
 */
function prepareDeliveredEvent(row, subscriptionMetadata = {}) {
  const event = { ...row, payload: parseJson(row.payload_json, {}) };
  const alreadyRedacted = row.redaction_state === "redacted";
  if (alreadyRedacted || subscriptionMetadata.accepts_unredacted === true) {
    event.redacted_by_delivery = false;
    return event;
  }
  event.payload = redactSensitiveKeysDeep(event.payload);
  event.original_redaction_state = row.redaction_state;
  event.redaction_state = "redacted";
  event.redacted_by_delivery = true;
  return event;
}

function deliverEvent(deliveryId, handler) {
  if (typeof handler !== "function") throw new Error("delivery handler is required");
  const delivery = claimEventDelivery(deliveryId);
  if (!delivery) return null;
  const row = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_id = ?").get(delivery.event_id);
  const subscriptionMetadata = parseJson(
    dbStore.getDb().prepare("SELECT metadata_json FROM platform_event_subscriptions WHERE subscription_id = ?").get(delivery.subscription_id)?.metadata_json,
    {}
  );
  const event = prepareDeliveredEvent(row, subscriptionMetadata);
  try {
    // Anything the handler publishes is caused by the event it is handling.
    runWithCausation(event.event_id, () => handler(event));
    return completeEventDelivery(delivery.delivery_id, { ok: true });
  } catch (error) {
    return completeEventDelivery(delivery.delivery_id, { ok: false, error: error.message });
  }
}

function listEventDeliveries({ subscription_id, status, limit = 50 } = {}) {
  ensurePlatformKernelSchema();
  const conditions = [];
  const params = [];
  if (subscription_id) { conditions.push("d.subscription_id = ?"); params.push(String(subscription_id)); }
  if (status) { conditions.push("d.status = ?"); params.push(String(status)); }
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  return dbStore.getDb().prepare(`
    SELECT d.*, s.name AS subscription_name, s.event_type, s.max_attempts
    FROM platform_event_deliveries d
    JOIN platform_event_subscriptions s ON s.subscription_id = d.subscription_id
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY d.created_at DESC LIMIT ?
  `).all(...params, boundedLimit).map(normalizeEventDelivery);
}

function getEventDeliveryStats() {
  ensurePlatformKernelSchema();
  const rows = dbStore.getDb().prepare("SELECT status, COUNT(*) AS count FROM platform_event_deliveries GROUP BY status").all();
  return rows.reduce((stats, row) => { stats[row.status] = row.count; return stats; }, { pending: 0, in_flight: 0, retry: 0, delivered: 0, dead_letter: 0 });
}

const CONNECTOR_STATES = Object.freeze(["registered", "configured", "enabled", "healthy", "error", "disabled", "retired"]);
const CONNECTOR_TRANSITIONS = Object.freeze({
  registered: ["configured", "enabled", "retired"],
  configured: ["enabled", "disabled", "retired"],
  enabled: ["configured", "healthy", "error", "disabled", "retired"],
  healthy: ["enabled", "error", "disabled", "retired"],
  error: ["enabled", "disabled", "retired"],
  disabled: ["configured", "enabled", "retired"],
  retired: [],
});

function normalizeConnector(row) {
  if (!row) return null;
  return {
    ...row,
    capabilities: parseJson(row.capabilities_json, []),
    config: parseJson(row.config_json, {}),
    health: parseJson(row.health_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function validateConnectorSecretRef(secretRef) {
  if (secretRef === undefined || secretRef === null || secretRef === "") return null;
  const value = String(secretRef);
  if (!/^secret:[A-Za-z0-9_.:/-]{1,190}$/.test(value)) throw new Error("secret_ref must be an opaque secret:name reference");
  return value;
}

function validateConnectorEndpoint(endpoint) {
  if (endpoint === undefined || endpoint === null || endpoint === "") return null;
  let parsed;
  try { parsed = new URL(String(endpoint)); } catch { throw new Error("connector endpoint must be a valid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("connector endpoint must be http(s) without embedded credentials");
  return parsed.toString();
}

function validateConnectorEndpointForType(type, endpoint) {
  const normalized = validateConnectorEndpoint(endpoint);
  if (normalized && String(type || "").toLowerCase() === "github" && !normalized.startsWith("https://")) {
    throw new Error("github connector endpoint must use HTTPS");
  }
  return normalized;
}

function assertConnectorConfigSafe(value, pathName = "config") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(api[_-]?key|access[_-]?token|password|private[_-]?key|webhook[_-]?url|^secret$)/i.test(key) && !/_ref$/i.test(key)) {
      throw new Error(`${pathName}.${key} must use a secret reference, not a credential value`);
    }
    if (child && typeof child === "object") assertConnectorConfigSafe(child, `${pathName}.${key}`);
  }
}

function registerConnectorLegacy(input = {}) {
  ensurePlatformKernelSchema();
  const name = String(input.name || "").trim();
  const type = String(input.type || "").trim();
  if (!name) throw new Error("connector name is required");
  if (!type) throw new Error("connector type is required");
  const config = input.config || {};
  assertConnectorConfigSafe(config);
  const secretRef = validateConnectorSecretRef(input.secret_ref);
  const connectorId = input.connector_id || newId("connector");
  const ts = nowIso();
  dbStore.getDb().prepare(`
    INSERT INTO platform_connectors
      (connector_id, name, type, state, endpoint, secret_ref, capabilities_json, config_json, registered_at, updated_at, metadata_json)
    VALUES (?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?, ?)
  `).run(connectorId, name, type, validateConnectorEndpointForType(type, input.endpoint), secretRef, json(input.capabilities || []), json(config), ts, ts, json(input.metadata || {}));
  const connector = getConnector(connectorId);
  appendEvent({ event_type: "connector.registered", source: input.source || "platform", subject_type: "connector", subject_id: connectorId, payload: { name, type, secret_ref: secretRef ? "present" : null }, correlation_id: connectorId });
  return connector;
}

function getConnectorLegacy(connectorId) {
  ensurePlatformKernelSchema();
  return normalizeConnector(dbStore.getDb().prepare("SELECT * FROM platform_connectors WHERE connector_id = ?").get(String(connectorId)));
}

function listConnectorsLegacy({ state, type, limit = 50 } = {}) {
  ensurePlatformKernelSchema();
  const conditions = [];
  const params = [];
  if (state) { if (!CONNECTOR_STATES.includes(state)) throw new Error(`Invalid connector state: ${state}`); conditions.push("state = ?"); params.push(state); }
  if (type) { conditions.push("type = ?"); params.push(String(type)); }
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  return dbStore.getDb().prepare(`SELECT * FROM platform_connectors ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, boundedLimit).map(normalizeConnector);
}

function listConnectorEventsLegacy(connectorId, limit = 20) {
  ensurePlatformKernelSchema();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  return dbStore.getDb().prepare(`
    SELECT event_id, event_type, timestamp, severity, payload_json
    FROM platform_execution_events
    WHERE subject_type = 'connector' AND subject_id = ?
    ORDER BY rowid DESC LIMIT ?
  `).all(String(connectorId), boundedLimit).map(row => ({
    event_id: row.event_id,
    event_type: row.event_type,
    timestamp: row.timestamp,
    severity: row.severity,
    payload: parseJson(row.payload_json, {}),
  }));
}

function transitionConnectorLegacy(connectorId, nextState, details = {}) {
  ensurePlatformKernelSchema();
  if (!CONNECTOR_STATES.includes(nextState)) throw new Error(`Invalid connector state: ${nextState}`);
  const current = getConnector(connectorId);
  if (!current) throw new Error(`Connector not found: ${connectorId}`);
  if (!(CONNECTOR_TRANSITIONS[current.state] || []).includes(nextState)) throw new Error(`Invalid connector transition: ${current.state} -> ${nextState}`);
  const ts = nowIso();
  dbStore.getDb().prepare("UPDATE platform_connectors SET state = ?, error = ?, updated_at = ? WHERE connector_id = ?").run(nextState, nextState === "error" ? String(details.error || "connector error").slice(0, 500) : null, ts, current.connector_id);
  appendEvent({ event_type: "connector.state_changed", source: details.source || "platform", subject_type: "connector", subject_id: current.connector_id, severity: nextState === "error" ? "warning" : "info", payload: { name: current.name, from: current.state, to: nextState, error: nextState === "error" ? String(details.error || "connector error").slice(0, 500) : null }, correlation_id: current.connector_id });
  return getConnector(current.connector_id);
}

function configureConnector(connectorId, input = {}) {
  ensurePlatformKernelSchema();
  const current = getConnector(connectorId);
  if (!current) throw new Error(`Connector not found: ${connectorId}`);
  if (!["registered", "configured", "disabled"].includes(current.state)) throw new Error(`Connector cannot be configured from state ${current.state}`);
  const config = input.config === undefined ? current.config : input.config;
  assertConnectorConfigSafe(config);
  const endpoint = input.endpoint === undefined ? current.endpoint : validateConnectorEndpoint(input.endpoint);
  const secretRef = input.secret_ref === undefined ? current.secret_ref : validateConnectorSecretRef(input.secret_ref);
  dbStore.getDb().prepare("UPDATE platform_connectors SET endpoint = ?, secret_ref = ?, config_json = ?, updated_at = ?, error = NULL WHERE connector_id = ?").run(endpoint, secretRef, json(config), nowIso(), current.connector_id);
  const configured = current.state === "configured" ? getConnector(current.connector_id) : transitionConnector(current.connector_id, "configured");
  appendEvent({ event_type: "connector.configured", source: input.source || "platform", subject_type: "connector", subject_id: current.connector_id, payload: { name: configured.name, has_endpoint: Boolean(endpoint), has_secret_ref: Boolean(secretRef) }, correlation_id: current.connector_id });
  return getConnector(current.connector_id);
}

function recordConnectorHealth(connectorId, health) {
  const current = getConnector(connectorId);
  if (!current) throw new Error(`Connector not found: ${connectorId}`);
  if (!["enabled", "healthy"].includes(current.state)) throw new Error(`Connector must be enabled before health checks (state: ${current.state})`);
  const result = typeof health === "boolean" ? { ok: health } : health;
  if (!result || typeof result.ok !== "boolean") throw new Error("connector health must return { ok: boolean }");
  const ts = nowIso();
  dbStore.getDb().prepare("UPDATE platform_connectors SET health_json = ?, last_health_check_at = ?, updated_at = ? WHERE connector_id = ?").run(json(result), ts, ts, current.connector_id);
  const next = result.ok ? (current.state === "enabled" ? transitionConnector(connectorId, "healthy") : getConnector(connectorId)) : transitionConnector(connectorId, "error", { error: result.error || "connector health check failed" });
  appendEvent({ event_type: "connector.health.check", source: "platform", subject_type: "connector", subject_id: current.connector_id, severity: result.ok ? "info" : "warning", payload: { name: current.name, ok: result.ok, state: next.state, health: result }, correlation_id: current.connector_id });
  return { ok: result.ok, connector: next, health: result };
}

function checkConnectorHealth(connectorId, probe) {
  if (typeof probe !== "function") throw new Error("connector health probe is required");
  try {
    const result = probe({ connector: getConnector(connectorId) });
    if (result && typeof result.then === "function") return recordConnectorHealth(connectorId, { ok: false, error: "connector health probe must be synchronous" });
    return recordConnectorHealth(connectorId, result);
  } catch (error) {
    return recordConnectorHealth(connectorId, { ok: false, error: String(error.message || error).slice(0, 300) });
  }
}

const connectorStore = createConnectorStore({
  ensureSchema: ensurePlatformKernelSchema,
  dbStore,
  states: CONNECTOR_STATES,
  transitions: CONNECTOR_TRANSITIONS,
  json,
  parseJson,
  nowIso,
  newId,
  appendEvent,
});
const {
  registerConnector,
  getConnector,
  listConnectors,
  listConnectorEvents,
  transitionConnector,
} = connectorStore;

function canonicalScopeValue(value) {
  if (Array.isArray(value)) return value.map(canonicalScopeValue);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => { out[key] = canonicalScopeValue(value[key]); return out; }, {});
  return value;
}

function scopeDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalScopeValue(value))).digest("hex");
}

function normalizeScopeSnapshot(row) {
  if (!row) return null;
  const targets = dbStore.getDb().prepare("SELECT target_id, kind, value_digest, created_at FROM platform_scope_targets WHERE snapshot_id = ? ORDER BY kind, target_id").all(row.snapshot_id);
  return {
    ...row,
    rules: parseJson(row.rules_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    target_count: targets.length,
    targets: targets.map(target => ({ target_id: target.target_id, kind: target.kind, value_digest: target.value_digest, created_at: target.created_at })),
  };
}

function createScopeSnapshot(input = {}) {
  ensurePlatformKernelSchema();
  if (!String(input.project_id || "").trim()) throw new Error("scope snapshot project_id is required");
  // Canonicalize through the registry choke point: scope snapshots join the
  // same project identity space as executions/events, so a casing variant must
  // resolve to the one canonical id (evaluateScope compares project ids).
  const projectId = normalizeProjectId(input.project_id);
  const createdBy = String(input.created_by || "").trim();
  if (!createdBy) throw new Error("scope snapshot created_by is required");
  if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > 100) throw new Error("scope snapshot requires 1-100 targets");
  const targets = input.targets.map((target, index) => {
    if (!target || typeof target !== "object" || !String(target.kind || "").trim() || !String(target.value || "").trim()) throw new Error(`scope target ${index} requires kind and value`);
    return { kind: String(target.kind).trim().slice(0, 80), value: String(target.value).trim().slice(0, 500), metadata: target.metadata || {} };
  });
  const rules = input.rules && typeof input.rules === "object" ? input.rules : {};
  if (rules.allowed_operations !== undefined && (!Array.isArray(rules.allowed_operations) || rules.allowed_operations.some(operation => typeof operation !== "string"))) throw new Error("rules.allowed_operations must be an array of strings");
  const expiresAt = input.expires_at || null;
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new Error("scope snapshot expires_at must be a future ISO timestamp");
  const digest = scopeDigest({ project_id: projectId, targets, rules, expires_at: expiresAt });
  const snapshotId = input.snapshot_id || newId("scope");
  const ts = nowIso();
  const db = dbStore.getDb();
  db.transaction(() => {
    db.prepare(`INSERT INTO platform_scope_snapshots (snapshot_id, project_id, digest, state, rules_json, created_by, created_at, expires_at, supersedes_snapshot_id, metadata_json) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`).run(snapshotId, projectId, digest, json(rules), createdBy, ts, expiresAt, input.supersedes_snapshot_id || null, json(input.metadata || {}));
    const insertTarget = db.prepare("INSERT INTO platform_scope_targets (target_id, snapshot_id, kind, value_digest, target_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const target of targets) insertTarget.run(newId("target"), snapshotId, target.kind, scopeDigest({ kind: target.kind, value: target.value }), json(target), ts);
  })();
  appendEvent({ event_type: "scope.snapshot.created", source: input.source || "platform", actor_id: createdBy, subject_type: "scope_snapshot", subject_id: snapshotId, project_id: projectId, payload: { digest, target_count: targets.length }, correlation_id: snapshotId });
  return getScopeSnapshot(snapshotId);
}

function getScopeSnapshot(snapshotId) {
  ensurePlatformKernelSchema();
  return normalizeScopeSnapshot(dbStore.getDb().prepare("SELECT * FROM platform_scope_snapshots WHERE snapshot_id = ?").get(String(snapshotId)));
}

function listScopeSnapshots({ project_id, state, limit = 50 } = {}) {
  ensurePlatformKernelSchema();
  const conditions = [];
  const params = [];
  if (project_id) { conditions.push("project_id = ?"); params.push(normalizeProjectId(project_id)); }
  if (state) { conditions.push("state = ?"); params.push(String(state)); }
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  return dbStore.getDb().prepare(`SELECT * FROM platform_scope_snapshots ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...params, boundedLimit).map(normalizeScopeSnapshot);
}

function evaluateScope(snapshotId, { project_id, target, target_kind, operation } = {}) {
  const snapshot = getScopeSnapshot(snapshotId);
  const targetValue = String(target || "").trim();
  const targetKind = String(target_kind || "host").trim();
  const operationName = String(operation || "").trim();
  let reason = "allowed";
  if (!snapshot) reason = "snapshot_not_found";
  else if (snapshot.state !== "active") reason = "snapshot_inactive";
  else if (snapshot.expires_at && Date.parse(snapshot.expires_at) <= Date.now()) reason = "snapshot_expired";
  else if (project_id && normalizeProjectId(project_id) !== snapshot.project_id) reason = "project_mismatch";
  else if (!targetValue || !operationName) reason = "target_and_operation_required";
  else if (!snapshot.targets.some(item => item.kind === targetKind && item.value_digest === scopeDigest({ kind: targetKind, value: targetValue }))) reason = "target_not_in_scope";
  else if (Array.isArray(snapshot.rules.allowed_operations) && !snapshot.rules.allowed_operations.includes("*") && !snapshot.rules.allowed_operations.includes(operationName)) reason = "operation_not_allowed";
  const targetDigest = targetValue ? scopeDigest({ kind: targetKind, value: targetValue }) : null;
  const decision = { ok: reason === "allowed", reason, snapshot_id: snapshot ? snapshot.snapshot_id : String(snapshotId), snapshot_digest: snapshot ? snapshot.digest : null, target_digest: targetDigest, operation: operationName || null };
  decision.decision_digest = scopeDigest(decision);
  appendEvent({ event_type: "scope.guard.decision", source: "platform", subject_type: "scope_snapshot", subject_id: snapshot ? snapshot.snapshot_id : String(snapshotId), project_id: snapshot ? snapshot.project_id : project_id || null, severity: decision.ok ? "info" : "warning", payload: { ok: decision.ok, reason, snapshot_digest: decision.snapshot_digest, target_digest: targetDigest, operation: decision.operation, decision_digest: decision.decision_digest }, correlation_id: decision.snapshot_id });
  return decision;
}

function bindExecutionScope(executionId, decision) {
  ensurePlatformKernelSchema();
  if (!decision || decision.ok !== true || !decision.snapshot_id || !decision.decision_digest) throw new Error("only an allowed scope decision can bind an execution");
  const execution = getExecution(executionId);
  if (!execution) throw new Error(`Execution not found: ${executionId}`);
  const snapshot = getScopeSnapshot(decision.snapshot_id);
  if (!snapshot || (execution.project_id && execution.project_id !== snapshot.project_id)) throw new Error("scope snapshot does not match execution project");
  const metadata = { ...(execution.metadata || {}), scope_snapshot_id: snapshot.snapshot_id, scope_snapshot_digest: snapshot.digest, scope_decision_digest: decision.decision_digest };
  dbStore.getDb().prepare("UPDATE platform_executions SET metadata_json = ?, updated_at = ? WHERE execution_id = ?").run(json(metadata), nowIso(), execution.execution_id);
  appendEvent({ event_type: "execution.scope_bound", source: "platform", execution_id: execution.execution_id, subject_type: "execution", subject_id: execution.execution_id, project_id: snapshot.project_id, payload: { scope_snapshot_id: snapshot.snapshot_id, scope_snapshot_digest: snapshot.digest, scope_decision_digest: decision.decision_digest }, correlation_id: execution.root_execution_id });
  return getExecution(execution.execution_id);
}

const RESEARCH_CAMPAIGN_STATES = Object.freeze(["draft", "active", "paused", "closed"]);
const RESEARCH_HYPOTHESIS_STATES = Object.freeze(["proposed", "ready", "blocked", "analysis_only", "not_run", "running", "inconclusive", "rejected", "supported", "confirmed"]);
const RESEARCH_TEST_RUN_STATES = Object.freeze(["not_run", "running", "completed", "inconclusive", "failed", "cancelled"]);
const CAMPAIGN_TRANSITIONS = Object.freeze({ draft: ["active", "closed"], active: ["paused", "closed"], paused: ["active", "closed"], closed: [] });
const HYPOTHESIS_TRANSITIONS = Object.freeze({ proposed: ["ready", "blocked", "rejected", "analysis_only"], ready: ["blocked", "running", "rejected", "analysis_only"], blocked: ["ready", "rejected"], analysis_only: ["ready", "rejected"], not_run: ["ready", "running", "rejected"], running: ["inconclusive", "supported", "confirmed", "rejected"], inconclusive: ["ready", "running", "rejected"], rejected: [], supported: ["confirmed", "rejected"], confirmed: [] });
const TEST_RUN_TRANSITIONS = Object.freeze({ not_run: ["running", "cancelled"], running: ["completed", "inconclusive", "failed", "cancelled"], completed: [], inconclusive: [], failed: [], cancelled: [] });

function normalizeResearchCampaign(row) { return row ? { ...row, metadata: parseJson(row.metadata_json, {}) } : null; }
function normalizeResearchHypothesis(row) { return row ? { ...row, prerequisites: parseJson(row.prerequisites_json, []), criteria: parseJson(row.criteria_json, {}), metadata: parseJson(row.metadata_json, {}) } : null; }
function normalizeResearchTestRun(row) { return row ? { ...row, environment: parseJson(row.environment_json, {}), evidence: parseJson(row.evidence_json, []), metadata: parseJson(row.metadata_json, {}) } : null; }
function requiredText(value, name) { const text = String(value || "").trim(); if (!text) throw new Error(`${name} must be a non-empty string`); return text; }
function normalizeResearchCampaignId(value) {
  const id = requiredText(value, "campaign_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || id === "." || id === "..") throw new Error("campaign_id must be a safe path segment");
  return id;
}
function boundedList(value, name) { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value; }

function createResearchCampaign(input = {}) {
  ensurePlatformKernelSchema();
  const projectId = normalizeProjectId(input.project_id), createdBy = requiredText(input.created_by, "created_by"), name = requiredText(input.name, "name");
  const state = input.state || "draft";
  if (!RESEARCH_CAMPAIGN_STATES.includes(state)) throw new Error(`Invalid campaign state: ${state}`);
  if (input.scope_snapshot_id) { const snapshot = getScopeSnapshot(input.scope_snapshot_id); if (!snapshot || snapshot.project_id !== projectId) throw new Error("scope_snapshot_id must belong to project"); }
  const campaignId = input.campaign_id === undefined ? newId("campaign") : normalizeResearchCampaignId(input.campaign_id), ts = input.created_at || nowIso();
  dbStore.getDb().prepare("INSERT INTO platform_research_campaigns (campaign_id, project_id, name, state, scope_snapshot_id, created_by, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(campaignId, projectId, name, state, input.scope_snapshot_id || null, createdBy, ts, ts, json(input.metadata || {}));
  appendEvent({ event_type: "research.campaign.created", source: input.source || "platform", actor_id: createdBy, subject_type: "research_campaign", subject_id: campaignId, project_id: projectId, payload: { name, state, scope_snapshot_id: input.scope_snapshot_id || null }, correlation_id: campaignId });
  return getResearchCampaign(campaignId);
}
function getResearchCampaign(campaignId) { ensurePlatformKernelSchema(); return normalizeResearchCampaign(dbStore.getDb().prepare("SELECT * FROM platform_research_campaigns WHERE campaign_id = ?").get(campaignId)); }
function listResearchCampaigns(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; if (query.project_id) { where.push("project_id = ?"); params.push(normalizeProjectId(query.project_id)); } if (query.state) { where.push("state = ?"); params.push(query.state); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_campaigns ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchCampaign); }
function transitionResearchCampaign(campaignId, state, details = {}) { ensurePlatformKernelSchema(); const current = getResearchCampaign(campaignId); if (!current || !RESEARCH_CAMPAIGN_STATES.includes(state) || !(CAMPAIGN_TRANSITIONS[current.state] || []).includes(state)) throw new Error(`Invalid campaign transition: ${current ? `${current.state} -> ${state}` : "missing campaign"}`); const ts = nowIso(); dbStore.getDb().prepare("UPDATE platform_research_campaigns SET state = ?, updated_at = ? WHERE campaign_id = ?").run(state, ts, campaignId); appendEvent({ event_type: "research.campaign.state_changed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "research_campaign", subject_id: campaignId, project_id: current.project_id, payload: { from: current.state, to: state, reason: details.reason || null }, correlation_id: campaignId }); return getResearchCampaign(campaignId); }

function createResearchHypothesis(input = {}) {
  ensurePlatformKernelSchema(); const campaign = getResearchCampaign(input.campaign_id); if (!campaign) throw new Error("campaign_id must reference an existing campaign");
  if (input.project_id && input.project_id !== campaign.project_id) throw new Error("project_id must match campaign");
  const title = requiredText(input.title, "title"), claim = requiredText(input.claim, "claim"), createdBy = requiredText(input.created_by, "created_by"), state = input.state || "proposed";
  if (!RESEARCH_HYPOTHESIS_STATES.includes(state)) throw new Error(`Invalid hypothesis state: ${state}`);
  if (input.confidence != null && (!Number.isFinite(Number(input.confidence)) || Number(input.confidence) < 0 || Number(input.confidence) > 1)) throw new Error("confidence must be between 0 and 1");
  const prerequisites = boundedList(input.prerequisites, "prerequisites"), criteria = input.criteria && typeof input.criteria === "object" && !Array.isArray(input.criteria) ? input.criteria : {};
  const hypothesisId = input.hypothesis_id || newId("hypothesis"), ts = input.created_at || nowIso();
  dbStore.getDb().prepare("INSERT INTO platform_research_hypotheses (hypothesis_id, campaign_id, project_id, title, claim, state, rationale, prerequisites_json, criteria_json, confidence, created_by, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(hypothesisId, campaign.campaign_id, campaign.project_id, title, claim, state, input.rationale || null, JSON.stringify(prerequisites), JSON.stringify(criteria), input.confidence == null ? null : Number(input.confidence), createdBy, ts, ts, json(input.metadata || {}));
  appendEvent({ event_type: "research.hypothesis.created", source: input.source || "platform", actor_id: createdBy, subject_type: "research_hypothesis", subject_id: hypothesisId, project_id: campaign.project_id, payload: { campaign_id: campaign.campaign_id, state }, correlation_id: campaign.campaign_id }); return getResearchHypothesis(hypothesisId);
}
function getResearchHypothesis(hypothesisId) { ensurePlatformKernelSchema(); return normalizeResearchHypothesis(dbStore.getDb().prepare("SELECT * FROM platform_research_hypotheses WHERE hypothesis_id = ?").get(hypothesisId)); }
function listResearchHypotheses(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; for (const key of ["campaign_id", "project_id", "state"]) if (query[key]) { where.push(`${key} = ?`); params.push(key === "project_id" ? normalizeProjectId(query[key]) : query[key]); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_hypotheses ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchHypothesis); }
function transitionResearchHypothesis(hypothesisId, state, details = {}) { ensurePlatformKernelSchema(); const current = getResearchHypothesis(hypothesisId); if (!current || !RESEARCH_HYPOTHESIS_STATES.includes(state) || !(HYPOTHESIS_TRANSITIONS[current.state] || []).includes(state)) throw new Error(`Invalid hypothesis transition: ${current ? `${current.state} -> ${state}` : "missing hypothesis"}`); const ts = nowIso(); dbStore.getDb().prepare("UPDATE platform_research_hypotheses SET state = ?, updated_at = ? WHERE hypothesis_id = ?").run(state, ts, hypothesisId); appendEvent({ event_type: "research.hypothesis.state_changed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "research_hypothesis", subject_id: hypothesisId, project_id: current.project_id, payload: { from: current.state, to: state, reason: details.reason || null }, correlation_id: current.campaign_id }); return getResearchHypothesis(hypothesisId); }

function createResearchTestRun(input = {}) {
  ensurePlatformKernelSchema(); const hypothesis = getResearchHypothesis(input.hypothesis_id); if (!hypothesis) throw new Error("hypothesis_id must reference an existing hypothesis"); const campaign = getResearchCampaign(hypothesis.campaign_id); const createdBy = requiredText(input.created_by, "created_by");
  if (input.project_id && input.project_id !== hypothesis.project_id) throw new Error("project_id must match hypothesis");
  const scopeSnapshotId = input.scope_snapshot_id || campaign.scope_snapshot_id || null;
  if (scopeSnapshotId) { const snapshot = getScopeSnapshot(scopeSnapshotId); if (!snapshot || snapshot.project_id !== hypothesis.project_id) throw new Error("scope_snapshot_id must belong to project"); }
  if (input.execution_id) { const execution = getExecution(input.execution_id); if (!execution || execution.project_id !== hypothesis.project_id) throw new Error("execution_id must belong to project"); }
  const state = input.state || "not_run"; if (!RESEARCH_TEST_RUN_STATES.includes(state)) throw new Error(`Invalid test run state: ${state}`);
  const testRunId = input.test_run_id || newId("test_run"), ts = input.created_at || nowIso(), evidence = boundedList(input.evidence, "evidence");
  dbStore.getDb().prepare("INSERT INTO platform_research_test_runs (test_run_id, hypothesis_id, campaign_id, project_id, execution_id, scope_snapshot_id, state, environment_json, outcome, evidence_json, created_by, created_at, started_at, completed_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(testRunId, hypothesis.hypothesis_id, campaign.campaign_id, hypothesis.project_id, input.execution_id || null, scopeSnapshotId, state, json(input.environment || {}), input.outcome || null, JSON.stringify(evidence), createdBy, ts, state === "running" ? ts : null, null, ts, json(input.metadata || {}));
  appendEvent({ event_type: "research.test_run.created", source: input.source || "platform", actor_id: createdBy, subject_type: "research_test_run", subject_id: testRunId, project_id: hypothesis.project_id, execution_id: input.execution_id || null, payload: { hypothesis_id: hypothesis.hypothesis_id, campaign_id: campaign.campaign_id, state, scope_snapshot_id: scopeSnapshotId }, correlation_id: campaign.campaign_id }); return getResearchTestRun(testRunId);
}
function getResearchTestRun(testRunId) { ensurePlatformKernelSchema(); return normalizeResearchTestRun(dbStore.getDb().prepare("SELECT * FROM platform_research_test_runs WHERE test_run_id = ?").get(testRunId)); }
function listResearchTestRuns(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; for (const key of ["project_id", "campaign_id", "hypothesis_id", "execution_id", "state"]) if (query[key]) { where.push(`${key} = ?`); params.push(key === "project_id" ? normalizeProjectId(query[key]) : query[key]); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_test_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchTestRun); }
function transitionResearchTestRun(testRunId, state, details = {}) { ensurePlatformKernelSchema(); const current = getResearchTestRun(testRunId); if (!current || !RESEARCH_TEST_RUN_STATES.includes(state) || !(TEST_RUN_TRANSITIONS[current.state] || []).includes(state)) throw new Error(`Invalid test run transition: ${current ? `${current.state} -> ${state}` : "missing test run"}`); const evidence = details.evidence === undefined ? current.evidence : boundedList(details.evidence, "evidence"), outcome = details.outcome === undefined ? current.outcome : details.outcome; if (state === "completed" && (!current.execution_id || evidence.length === 0 || !outcome)) throw new Error("completed test runs require execution_id, outcome, and evidence"); const ts = nowIso(), terminal = ["completed", "inconclusive", "failed", "cancelled"].includes(state); dbStore.getDb().prepare("UPDATE platform_research_test_runs SET state = ?, outcome = ?, evidence_json = ?, started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ? WHERE test_run_id = ?").run(state, outcome || null, JSON.stringify(evidence), state === "running" ? ts : null, terminal ? ts : null, ts, testRunId); appendEvent({ event_type: "research.test_run.state_changed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "research_test_run", subject_id: testRunId, project_id: current.project_id, execution_id: current.execution_id, payload: { from: current.state, to: state, outcome: outcome || null, evidence_count: evidence.length }, correlation_id: current.campaign_id }); return getResearchTestRun(testRunId); }

const RESEARCH_FINDING_STATUSES = Object.freeze(["analysis_only", "proposed", "supported", "confirmed", "rejected"]);
const RESEARCH_REPORT_STATUSES = Object.freeze(["draft", "internal_review", "ready"]);
function normalizeResearchFinding(row) { return row ? { ...row, evidence_refs: parseJson(row.evidence_refs_json, []), metadata: parseJson(row.metadata_json, {}) } : null; }
function normalizeResearchReport(row) { return row ? { ...row, finding_refs: parseJson(row.finding_refs_json, []), metadata: parseJson(row.metadata_json, {}) } : null; }
function confirmedEvidenceRefs(refs, projectId) {
  const artifacts = (refs || []).map(ref => String(ref || "").replace(/^artifact:/, "")).filter(Boolean).map(ref => getArtifact(ref)).filter(artifact => artifact && (!projectId || String(artifact.project_id || "") === String(projectId)));
  if (!artifacts.length || artifacts.length !== (refs || []).length) return false;
  return artifacts.some(artifact => canSupportAuthoritativeCompletion(normalizeEvidenceMetadata(parseJson(artifact.metadata_json, artifact.metadata || {}), { evidence_class: "exact_source_evidence", completeness: "complete" })));
}
function createResearchFinding(input = {}) {
  ensurePlatformKernelSchema(); const campaign = getResearchCampaign(input.campaign_id); if (!campaign) throw new Error("campaign_id must reference an existing campaign");
  const createdBy = requiredText(input.created_by, "created_by"), title = requiredText(input.title, "title"), claim = requiredText(input.claim, "claim"), status = input.status || "analysis_only", refs = boundedList(input.evidence_refs, "evidence_refs");
  if (!RESEARCH_FINDING_STATUSES.includes(status)) throw new Error(`Invalid finding status: ${status}`);
  let hypothesis = null, testRun = null;
  if (input.hypothesis_id) { hypothesis = getResearchHypothesis(input.hypothesis_id); if (!hypothesis || hypothesis.campaign_id !== campaign.campaign_id) throw new Error("hypothesis_id must belong to campaign"); }
  if (input.test_run_id) { testRun = getResearchTestRun(input.test_run_id); if (!testRun || testRun.campaign_id !== campaign.campaign_id) throw new Error("test_run_id must belong to campaign"); }
  if (status === "confirmed" && (!testRun || testRun.state !== "completed" || refs.length === 0 || !confirmedEvidenceRefs(refs, campaign.project_id))) throw new Error("confirmed findings require a completed test run and evidence references (exact/runtime evidence required)");
  const findingId = input.finding_id || newId("finding"), ts = input.created_at || nowIso();
  dbStore.getDb().prepare("INSERT INTO platform_research_findings (finding_id, project_id, campaign_id, hypothesis_id, test_run_id, title, claim, status, impact, evidence_refs_json, created_by, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(findingId, campaign.project_id, campaign.campaign_id, hypothesis ? hypothesis.hypothesis_id : null, testRun ? testRun.test_run_id : null, title, claim, status, input.impact || null, JSON.stringify(refs), createdBy, ts, ts, json(input.metadata || {}));
  appendEvent({ event_type: "research.finding.created", source: input.source || "platform", actor_id: createdBy, subject_type: "research_finding", subject_id: findingId, project_id: campaign.project_id, payload: { campaign_id: campaign.campaign_id, status, evidence_count: refs.length }, correlation_id: campaign.campaign_id }); return getResearchFinding(findingId);
}
function getResearchFinding(findingId) { ensurePlatformKernelSchema(); return normalizeResearchFinding(dbStore.getDb().prepare("SELECT * FROM platform_research_findings WHERE finding_id = ?").get(findingId)); }
function listResearchFindings(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; for (const key of ["project_id", "campaign_id", "hypothesis_id", "test_run_id", "status"]) if (query[key]) { where.push(`${key} = ?`); params.push(query[key]); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_findings ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchFinding); }
function requireResearchArtifactForProject(artifactId, projectId) {
  const artifact = getArtifact(artifactId);
  if (!artifact) throw new Error("artifact_id must reference an existing artifact");
  if (!artifact.project_id || normalizeProjectId(artifact.project_id) !== normalizeProjectId(projectId)) {
    throw new Error("artifact_id must belong to the research campaign project");
  }
  return artifact;
}
function createResearchReport(input = {}) {
  ensurePlatformKernelSchema(); const campaign = getResearchCampaign(input.campaign_id); if (!campaign) throw new Error("campaign_id must reference an existing campaign");
  const createdBy = requiredText(input.created_by, "created_by"), title = requiredText(input.title, "title"), refs = boundedList(input.finding_refs, "finding_refs"), status = input.status || "draft";
  if (!RESEARCH_REPORT_STATUSES.includes(status)) throw new Error(`Invalid report status: ${status}`);
  for (const findingId of refs) { const finding = getResearchFinding(findingId); if (!finding || finding.campaign_id !== campaign.campaign_id) throw new Error("finding_refs must belong to campaign"); }
  if (input.artifact_id) requireResearchArtifactForProject(input.artifact_id, campaign.project_id);
  const reportId = input.report_id || newId("report"), ts = input.created_at || nowIso();
  dbStore.getDb().prepare("INSERT INTO platform_research_reports (report_id, project_id, campaign_id, artifact_id, title, status, finding_refs_json, created_by, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reportId, campaign.project_id, campaign.campaign_id, input.artifact_id || null, title, status, JSON.stringify(refs), createdBy, ts, ts, json(input.metadata || {}));
  appendEvent({ event_type: "research.report.created", source: input.source || "platform", actor_id: createdBy, subject_type: "research_report", subject_id: reportId, project_id: campaign.project_id, payload: { campaign_id: campaign.campaign_id, status, finding_count: refs.length, artifact_id: input.artifact_id || null }, correlation_id: campaign.campaign_id }); return getResearchReport(reportId);
}
function getResearchReport(reportId) { ensurePlatformKernelSchema(); return normalizeResearchReport(dbStore.getDb().prepare("SELECT * FROM platform_research_reports WHERE report_id = ?").get(reportId)); }
function listResearchReports(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; for (const key of ["project_id", "campaign_id", "status"]) if (query[key]) { where.push(`${key} = ?`); params.push(query[key]); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_reports ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchReport); }

const RESEARCH_DISCLOSURE_STATES = Object.freeze(["draft", "internal_review", "ready", "submitted", "acknowledged", "triage", "duplicate", "informative", "accepted", "remediation", "resolved", "retest", "bounty", "closed"]);
const DISCLOSURE_TRANSITIONS = Object.freeze({ draft: ["internal_review"], internal_review: ["draft", "ready"], ready: ["internal_review", "submitted"], submitted: ["acknowledged", "triage", "duplicate", "informative", "accepted"], acknowledged: ["triage", "duplicate", "informative", "accepted"], triage: ["duplicate", "informative", "accepted", "remediation"], accepted: ["remediation", "resolved", "retest", "bounty"], remediation: ["resolved", "retest"], resolved: ["retest", "closed"], retest: ["resolved", "closed"], bounty: ["closed"], duplicate: ["closed"], informative: ["closed"], closed: [] });
function normalizeResearchDisclosure(row) { return row ? { ...row, metadata: parseJson(row.metadata_json, {}) } : null; }
function createResearchDisclosure(input = {}) {
  ensurePlatformKernelSchema(); const campaign = getResearchCampaign(input.campaign_id); if (!campaign) throw new Error("campaign_id must reference an existing campaign"); const report = getResearchReport(input.report_id); if (!report || report.campaign_id !== campaign.campaign_id) throw new Error("report_id must belong to campaign"); const createdBy = requiredText(input.created_by, "created_by"), state = input.state || "draft"; if (!RESEARCH_DISCLOSURE_STATES.includes(state)) throw new Error(`Invalid disclosure state: ${state}`); if (input.artifact_id) requireResearchArtifactForProject(input.artifact_id, campaign.project_id); if (report.artifact_id) requireResearchArtifactForProject(report.artifact_id, campaign.project_id); const disclosureId = input.disclosure_id || newId("disclosure"), ts = input.created_at || nowIso(); dbStore.getDb().prepare("INSERT INTO platform_research_disclosures (disclosure_id, project_id, campaign_id, report_id, artifact_id, recipient_ref, approval_ref, state, created_by, created_at, updated_at, submitted_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(disclosureId, campaign.project_id, campaign.campaign_id, report.report_id, input.artifact_id || report.artifact_id || null, input.recipient_ref || null, input.approval_ref || null, state, createdBy, ts, ts, state === "submitted" ? ts : null, json(input.metadata || {})); appendEvent({ event_type: "research.disclosure.created", source: input.source || "platform", actor_id: createdBy, subject_type: "research_disclosure", subject_id: disclosureId, project_id: campaign.project_id, payload: { campaign_id: campaign.campaign_id, report_id: report.report_id, state }, correlation_id: campaign.campaign_id }); return getResearchDisclosure(disclosureId);
}
function getResearchDisclosure(disclosureId) { ensurePlatformKernelSchema(); return normalizeResearchDisclosure(dbStore.getDb().prepare("SELECT * FROM platform_research_disclosures WHERE disclosure_id = ?").get(disclosureId)); }
function listResearchDisclosures(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; for (const key of ["project_id", "campaign_id", "report_id", "state"]) if (query[key]) { where.push(`${key} = ?`); params.push(query[key]); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_disclosures ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchDisclosure); }
function transitionResearchDisclosure(disclosureId, state, details = {}) { ensurePlatformKernelSchema(); const current = getResearchDisclosure(disclosureId); if (!current || !RESEARCH_DISCLOSURE_STATES.includes(state) || !(DISCLOSURE_TRANSITIONS[current.state] || []).includes(state)) throw new Error(`Invalid disclosure transition: ${current ? `${current.state} -> ${state}` : "missing disclosure"}`); const actor = requiredText(details.actor_id, "actor_id"); if (state === "submitted" && !current.approval_ref) throw new Error("submitted disclosure requires approval_ref"); const ts = nowIso(), submittedAt = state === "submitted" ? ts : current.submitted_at; dbStore.getDb().prepare("UPDATE platform_research_disclosures SET state = ?, updated_at = ?, submitted_at = ? WHERE disclosure_id = ?").run(state, ts, submittedAt, disclosureId); appendEvent({ event_type: "research.disclosure.state_changed", source: details.source || "platform", actor_id: actor, subject_type: "research_disclosure", subject_id: disclosureId, project_id: current.project_id, payload: { from: current.state, to: state, approval_present: Boolean(current.approval_ref) }, correlation_id: current.campaign_id }); return getResearchDisclosure(disclosureId); }

const RESEARCH_SOURCE_REPOSITORY_STATES = Object.freeze(["active", "archived"]);
const RESEARCH_SOURCE_SNAPSHOT_STATES = Object.freeze(["staging", "finalized", "archived", "removed"]);
function normalizeResearchSourceRepository(row) { return row ? { ...row, metadata: parseJson(row.metadata_json, {}) } : null; }
function normalizeResearchSourceSnapshot(row) { return row ? { ...row, verification: parseJson(row.verification_json, {}), authority_provenance: parseJson(row.authority_provenance_json, {}), semantic_index: parseJson(row.semantic_index_json, {}), warnings: parseJson(row.warnings_json, []), retention: parseJson(row.retention_json, {}), metadata: parseJson(row.metadata_json, {}) } : null; }
function createResearchSourceRepository(input = {}) { ensurePlatformKernelSchema(); const campaign = getResearchCampaign(requiredText(input.campaign_id, "campaign_id")); if (!campaign) throw new Error("campaign_id must reference an existing campaign"); if (input.project_id && normalizeProjectId(input.project_id) !== campaign.project_id) throw new Error("project_id must match campaign"); const name = requiredText(input.name, "name"), createdBy = requiredText(input.created_by, "created_by"), repositoryId = input.repository_id || newId("source_repo"), ts = input.created_at || nowIso(); dbStore.getDb().prepare("INSERT INTO platform_research_source_repositories (repository_id, campaign_id, project_id, name, state, created_by, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)").run(repositoryId, campaign.campaign_id, campaign.project_id, name, createdBy, ts, ts, json(input.metadata || {})); appendEvent({ event_type: "research.source.repository.created", source: input.source || "platform", actor_id: createdBy, subject_type: "research_source_repository", subject_id: repositoryId, project_id: campaign.project_id, payload: { campaign_id: campaign.campaign_id, name }, correlation_id: campaign.campaign_id }); return getResearchSourceRepository(repositoryId); }
function getResearchSourceRepository(repositoryId) { ensurePlatformKernelSchema(); return normalizeResearchSourceRepository(dbStore.getDb().prepare("SELECT * FROM platform_research_source_repositories WHERE repository_id = ?").get(String(repositoryId))); }
function listResearchSourceRepositories(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; for (const key of ["campaign_id", "project_id", "state"]) if (query[key]) { where.push(`${key} = ?`); params.push(key === "project_id" ? normalizeProjectId(query[key]) : String(query[key])); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_source_repositories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchSourceRepository); }
function createResearchSourceSnapshot(input = {}) { ensurePlatformKernelSchema(); const repo = getResearchSourceRepository(requiredText(input.repository_id, "repository_id")); if (!repo) throw new Error("repository_id must reference an existing source repository"); if (input.campaign_id && String(input.campaign_id) !== repo.campaign_id) throw new Error("campaign_id must match repository"); if (input.project_id && normalizeProjectId(input.project_id) !== repo.project_id) throw new Error("project_id must match repository"); const storageRef = requiredText(input.storage_ref, "storage_ref"); if (path.posix.normalize(storageRef) !== storageRef || storageRef.startsWith("/") || storageRef.split("/").includes("..")) throw new Error("storage_ref must be workspace-relative"); const contentHash = requiredText(input.content_hash, "content_hash"), authority = input.authority || "derived_analysis_input"; if (authority !== "derived_analysis_input") throw new Error("source snapshots cannot be promoted to another authority"); const state = input.state || "staging"; if (!RESEARCH_SOURCE_SNAPSHOT_STATES.includes(state)) throw new Error(`Invalid source snapshot state: ${state}`); const snapshotId = input.snapshot_id || newId("source_snap"), ts = input.created_at || nowIso(); dbStore.getDb().prepare("INSERT INTO platform_research_source_snapshots (snapshot_id, repository_id, campaign_id, project_id, state, storage_ref, content_hash, file_count, byte_count, max_depth, authority, created_by, created_at, finalized_at, verification_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(snapshotId, repo.repository_id, repo.campaign_id, repo.project_id, state, storageRef, contentHash, Number(input.file_count) || 0, Number(input.byte_count) || 0, Number(input.max_depth) || 0, authority, requiredText(input.created_by, "created_by"), ts, state === "finalized" ? ts : null, json(input.verification || {}), json(input.metadata || {})); appendEvent({ event_type: "research.source.snapshot.created", source: input.source || "platform", actor_id: input.created_by, subject_type: "research_source_snapshot", subject_id: snapshotId, project_id: repo.project_id, payload: { repository_id: repo.repository_id, campaign_id: repo.campaign_id, state, file_count: Number(input.file_count) || 0, byte_count: Number(input.byte_count) || 0, content_hash: contentHash, authority }, correlation_id: repo.campaign_id }); return getResearchSourceSnapshot(snapshotId); }
function getResearchSourceSnapshot(snapshotId) { ensurePlatformKernelSchema(); return normalizeResearchSourceSnapshot(dbStore.getDb().prepare("SELECT * FROM platform_research_source_snapshots WHERE snapshot_id = ?").get(String(snapshotId))); }
function listResearchSourceSnapshots(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; for (const key of ["repository_id", "campaign_id", "project_id", "state"]) if (query[key]) { where.push(`${key} = ?`); params.push(key === "project_id" ? normalizeProjectId(query[key]) : String(query[key])); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_source_snapshots ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchSourceSnapshot); }
function transitionResearchSourceRepository(repositoryId, state, details = {}) { ensurePlatformKernelSchema(); const current = getResearchSourceRepository(repositoryId); if (!current || !RESEARCH_SOURCE_REPOSITORY_STATES.includes(state)) throw new Error("Invalid source repository transition"); if (current.state === state) return current; if (current.state === "archived" || state !== "archived") throw new Error(`Invalid source repository transition: ${current.state} -> ${state}`); const ts = nowIso(); dbStore.getDb().prepare("UPDATE platform_research_source_repositories SET state = ?, archived_at = ?, updated_at = ? WHERE repository_id = ?").run(state, ts, ts, current.repository_id); appendEvent({ event_type: "research.source.repository.state_changed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "research_source_repository", subject_id: current.repository_id, project_id: current.project_id, payload: { from: current.state, to: state }, correlation_id: current.campaign_id }); return getResearchSourceRepository(current.repository_id); }
function transitionResearchSourceSnapshot(snapshotId, state, details = {}) { ensurePlatformKernelSchema(); const current = getResearchSourceSnapshot(snapshotId); if (!current || !RESEARCH_SOURCE_SNAPSHOT_STATES.includes(state)) throw new Error("Invalid source snapshot transition"); const allowed = { staging: ["finalized", "removed"], finalized: ["archived", "removed"], archived: ["removed"], removed: [] }; if (current.state === state) return current; if (!(allowed[current.state] || []).includes(state)) throw new Error(`Invalid source snapshot transition: ${current.state} -> ${state}`); if (state === "archived" && current.state !== "finalized") throw new Error("only finalized source snapshots can be archived"); const repository = getResearchSourceRepository(current.repository_id); if (state === "archived" && repository && repository.selected_snapshot_id === current.snapshot_id) throw new Error("selected source snapshot cannot be archived"); const ts = nowIso(); dbStore.getDb().prepare("UPDATE platform_research_source_snapshots SET state = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END, removed_at = CASE WHEN ? = 'removed' THEN ? ELSE removed_at END WHERE snapshot_id = ?").run(state, state, ts, state, ts, current.snapshot_id); appendEvent({ event_type: "research.source.snapshot.state_changed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "research_source_snapshot", subject_id: current.snapshot_id, project_id: current.project_id, payload: { repository_id: current.repository_id, from: current.state, to: state }, correlation_id: current.campaign_id }); return getResearchSourceSnapshot(current.snapshot_id); }
function selectResearchSourceSnapshot(repositoryId, snapshotId, details = {}) { ensurePlatformKernelSchema(); const repo = getResearchSourceRepository(repositoryId), snapshot = getResearchSourceSnapshot(snapshotId); if (!repo || !snapshot || snapshot.repository_id !== repo.repository_id || snapshot.campaign_id !== repo.campaign_id) throw new Error("snapshot must belong to repository"); if (repo.state !== "active" || snapshot.state !== "finalized") throw new Error("only an active repository can select a finalized snapshot"); const ts = nowIso(); dbStore.getDb().prepare("UPDATE platform_research_source_repositories SET selected_snapshot_id = ?, updated_at = ? WHERE repository_id = ?").run(snapshot.snapshot_id, ts, repo.repository_id); appendEvent({ event_type: "research.source.snapshot.selected", source: details.source || "platform", actor_id: details.actor_id, subject_type: "research_source_snapshot", subject_id: snapshot.snapshot_id, project_id: repo.project_id, payload: { repository_id: repo.repository_id, previous_snapshot_id: repo.selected_snapshot_id || null }, correlation_id: repo.campaign_id }); return getResearchSourceRepository(repo.repository_id); }
function removeResearchSourceSnapshot(snapshotId, details = {}) { ensurePlatformKernelSchema(); const snapshot = getResearchSourceSnapshot(snapshotId); if (!snapshot) throw new Error("source snapshot not found"); const repo = getResearchSourceRepository(snapshot.repository_id); if (repo.selected_snapshot_id === snapshot.snapshot_id) throw new Error("source snapshot is referenced by repository selection"); return transitionResearchSourceSnapshot(snapshot.snapshot_id, "removed", details); }

const RESEARCH_SOURCE_AUTHORITY_CLASSES = Object.freeze(["derived_analysis_input", "declared_source_authority"]);
const RESEARCH_SOURCE_AUTHORITY_STATES = Object.freeze(["active", "revoked"]);
function normalizeResearchSourceAuthorityClaim(row) {
  return row ? { ...row, scope: parseJson(row.scope_json, {}), evidence_refs: parseJson(row.evidence_refs_json, []), metadata: parseJson(row.metadata_json, {}) } : null;
}
function createResearchSourceAuthorityClaim(input = {}) {
  ensurePlatformKernelSchema();
  const snapshot = getResearchSourceSnapshot(requiredText(input.snapshot_id, "snapshot_id"));
  if (!snapshot) throw new Error("snapshot_id must reference an existing source snapshot");
  const repository = getResearchSourceRepository(snapshot.repository_id);
  if (!repository || repository.repository_id !== snapshot.repository_id) throw new Error("snapshot repository is unavailable");
  if (!["finalized", "archived"].includes(snapshot.state)) throw new Error("authority claims require a finalized snapshot");
  if (input.campaign_id && String(input.campaign_id) !== snapshot.campaign_id) throw new Error("campaign_id must match snapshot");
  if (input.project_id && normalizeProjectId(input.project_id) !== snapshot.project_id) throw new Error("project_id must match snapshot");
  const authorityClass = requiredText(input.authority_class, "authority_class");
  if (!RESEARCH_SOURCE_AUTHORITY_CLASSES.includes(authorityClass)) throw new Error("unsupported source authority class");
  const scope = input.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).length === 0) throw new Error("scope must be a non-empty object");
  const refs = boundedList(input.evidence_refs, "evidence_refs").map(ref => requiredText(ref, "evidence_ref"));
  if (refs.length === 0 || refs.length > 100) throw new Error("evidence_refs must contain between 1 and 100 references");
  for (const ref of refs) {
    if (!/^artifact:[A-Za-z0-9_.:-]{1,200}$/.test(ref)) throw new Error("evidence_refs must contain artifact references");
    const artifact = getArtifact(ref.slice("artifact:".length));
    if (!artifact || String(artifact.project_id || "") !== String(snapshot.project_id)) throw new Error("evidence_refs must belong to snapshot project");
  }
  const declaringActor = requiredText(input.declaring_actor, "declaring_actor");
  const state = input.state || "active";
  if (!RESEARCH_SOURCE_AUTHORITY_STATES.includes(state)) throw new Error(`Invalid source authority claim state: ${state}`);
  const claimId = input.claim_id || newId("source_authority_claim"), ts = input.declared_at || nowIso();
  dbStore.getDb().prepare("INSERT INTO platform_research_source_authority_claims (claim_id, snapshot_id, repository_id, campaign_id, project_id, authority_class, scope_json, evidence_refs_json, declaring_actor, declared_at, state, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(claimId, snapshot.snapshot_id, repository.repository_id, snapshot.campaign_id, snapshot.project_id, authorityClass, json(scope), JSON.stringify(refs), declaringActor, ts, state, json(input.metadata || {}));
  appendEvent({ event_type: "research.source.authority.claimed", source: input.source || "platform", actor_id: declaringActor, subject_type: "research_source_authority_claim", subject_id: claimId, project_id: snapshot.project_id, payload: { snapshot_id: snapshot.snapshot_id, repository_id: repository.repository_id, authority_class: authorityClass, evidence_count: refs.length }, correlation_id: snapshot.campaign_id });
  return getResearchSourceAuthorityClaim(claimId);
}
function getResearchSourceAuthorityClaim(claimId) { ensurePlatformKernelSchema(); return normalizeResearchSourceAuthorityClaim(dbStore.getDb().prepare("SELECT * FROM platform_research_source_authority_claims WHERE claim_id = ?").get(String(claimId))); }
function listResearchSourceAuthorityClaims(query = {}) { ensurePlatformKernelSchema(); const where = [], params = []; for (const key of ["snapshot_id", "repository_id", "campaign_id", "project_id", "authority_class", "state"]) if (query[key]) { where.push(`${key} = ?`); params.push(key === "project_id" ? normalizeProjectId(query[key]) : String(query[key])); } const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100); return dbStore.getDb().prepare(`SELECT * FROM platform_research_source_authority_claims ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY declared_at DESC LIMIT ?`).all(...params, limit).map(normalizeResearchSourceAuthorityClaim); }
function transitionResearchSourceAuthorityClaim(claimId, state, details = {}) { ensurePlatformKernelSchema(); const current = getResearchSourceAuthorityClaim(claimId); if (!current || !RESEARCH_SOURCE_AUTHORITY_STATES.includes(state) || current.state === state) throw new Error("invalid source authority claim transition"); const actor = requiredText(details.actor_id, "actor_id"), ts = nowIso(); dbStore.getDb().prepare("UPDATE platform_research_source_authority_claims SET state = ? WHERE claim_id = ?").run(state, current.claim_id); appendEvent({ event_type: "research.source.authority.state_changed", source: details.source || "platform", actor_id: actor, subject_type: "research_source_authority_claim", subject_id: current.claim_id, project_id: current.project_id, payload: { from: current.state, to: state }, correlation_id: current.campaign_id }); return getResearchSourceAuthorityClaim(current.claim_id); }

function updateResearchSourceSnapshotProvenance(snapshotId, input = {}) {
  ensurePlatformKernelSchema();
  const current = getResearchSourceSnapshot(snapshotId);
  if (!current || current.state === "removed") throw new Error("source snapshot is unavailable");
  const ts = input.verification_at || nowIso();
  dbStore.getDb().prepare("UPDATE platform_research_source_snapshots SET acquisition_operation_id = COALESCE(?, acquisition_operation_id), source_type = COALESCE(?, source_type), requested_ref = COALESCE(?, requested_ref), resolved_commit_sha = COALESCE(?, resolved_commit_sha), branch = COALESCE(?, branch), remote_identity = COALESCE(?, remote_identity), source_root_hash = COALESCE(?, source_root_hash), verification_at = COALESCE(?, verification_at), semantic_index_json = COALESCE(?, semantic_index_json), warnings_json = COALESCE(?, warnings_json), metadata_json = ? WHERE snapshot_id = ?").run(input.acquisition_operation_id || null, input.source_type || null, input.requested_ref || null, input.resolved_commit_sha || null, input.branch || null, input.remote_identity || null, input.source_root_hash || null, ts, input.semantic_index ? json(input.semantic_index) : null, input.warnings ? JSON.stringify(input.warnings) : null, json({ ...(current.metadata || {}), ...(input.metadata || {}) }), current.snapshot_id);
  appendEvent({ event_type: "research.source.snapshot.provenance_updated", source: input.source || "platform", actor_id: input.actor_id, subject_type: "research_source_snapshot", subject_id: current.snapshot_id, project_id: current.project_id, payload: { source_type: input.source_type || null, resolved_commit_sha: input.resolved_commit_sha || null }, correlation_id: current.campaign_id });
  return getResearchSourceSnapshot(current.snapshot_id);
}
function markResearchSourceSnapshotVerification(snapshotId, verification, details = {}) { ensurePlatformKernelSchema(); const current = getResearchSourceSnapshot(snapshotId); if (!current || current.state === "removed") throw new Error("source snapshot is unavailable"); const ts = nowIso(); dbStore.getDb().prepare("UPDATE platform_research_source_snapshots SET verification_json = ?, verification_at = ?, warnings_json = ? WHERE snapshot_id = ?").run(json(verification || {}), ts, JSON.stringify(verification && verification.verified === false ? ["snapshot_content_changed"] : []), current.snapshot_id); appendEvent({ event_type: "research.source.snapshot.verified", source: details.source || "platform", actor_id: details.actor_id, subject_type: "research_source_snapshot", subject_id: current.snapshot_id, project_id: current.project_id, payload: { verified: verification && verification.verified === true, state: verification && verification.state || "unknown" }, correlation_id: current.campaign_id }); return getResearchSourceSnapshot(current.snapshot_id); }

function registerArtifactLegacy(input = {}) {
  ensurePlatformKernelSchema();
  if (!input.storage_ref) throw new Error("storage_ref is required");
  const normalizedRef = path.posix.normalize(String(input.storage_ref).replace(/\\/g, "/"));
  if (normalizedRef.includes("../") || normalizedRef === ".." || path.isAbsolute(normalizedRef)) {
    throw new Error("storage_ref must be a safe relative path or opaque storage key");
  }
  const lineage = input.lineage && typeof input.lineage === "object" ? { ...input.lineage } : {};
  const custodyRole = lineage.role || (input.supersedes_artifact_id ? "derivative" : "original");
  if (!["original", "derivative"].includes(custodyRole)) throw new Error("artifact lineage role must be original or derivative");
  if (custodyRole === "original" && input.supersedes_artifact_id) throw new Error("original artifacts cannot supersede another artifact");
  if (custodyRole === "derivative" && !input.supersedes_artifact_id) throw new Error("derivative artifacts require supersedes_artifact_id");
  if (input.supersedes_artifact_id) {
    const parent = dbStore.getDb().prepare("SELECT artifact_id, project_id, deleted_at FROM platform_artifacts WHERE artifact_id = ?").get(input.supersedes_artifact_id);
    if (!parent) throw new Error(`Parent artifact not found: ${input.supersedes_artifact_id}`);
    if (parent.deleted_at) throw new Error("derivatives cannot be created from deleted artifacts");
    if (String(parent.project_id || "") !== String(input.project_id || "")) throw new Error("derivative parent must belong to the same project");
  }
  if (input.content_hash !== undefined && !/^(?:sha256:)?[a-f0-9]{64}$/i.test(String(input.content_hash))) {
    throw new Error("content_hash must be a SHA-256 digest");
  }
  if (input.byte_size !== undefined && (!Number.isInteger(input.byte_size) || input.byte_size < 0)) {
    throw new Error("byte_size must be a non-negative integer");
  }
  lineage.role = custodyRole;
  const artifactId = input.artifact_id || newId("art");
  const ts = input.created_at || nowIso();
  dbStore.getDb().prepare(`
    INSERT INTO platform_artifacts (
      artifact_id, type, name, project_id, execution_id, task_id, session_id, producer, storage_ref,
      content_type, byte_size, content_hash, created_at, retention_class, sensitivity, redaction_state,
      schema_version, lineage_json, verification_json, supersedes_artifact_id, metadata_json,
      owner_principal_id, created_by_principal_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId,
    input.type || "artifact",
    input.name || artifactId,
    input.project_id || null,
    input.execution_id || null,
    input.task_id || null,
    input.session_id || null,
    input.producer || null,
    normalizedRef,
    input.content_type || null,
    Number.isInteger(input.byte_size) ? input.byte_size : null,
    input.content_hash || null,
    ts,
    input.retention_class || "standard",
    input.sensitivity || "normal",
    input.redaction_state || "unknown",
    json(lineage),
    json(input.verification || {}),
    input.supersedes_artifact_id || null,
    json(input.metadata || {}),
    input.ownerPrincipalId || input.owner_principal_id || null,
    input.createdByPrincipalId || input.created_by_principal_id || input.actor_principal_id || null
  );
  if (input.execution_id) {
    dbStore.getDb().prepare("UPDATE platform_executions SET artifact_count = artifact_count + 1, updated_at = ? WHERE execution_id = ?").run(ts, input.execution_id);
  }
  appendEvent({
    event_type: "artifact.registered",
    source: input.source || "platform",
    actor_id: input.actor_id,
    execution_id: input.execution_id,
    task_id: input.task_id,
    session_id: input.session_id,
    project_id: input.project_id,
    subject_type: "artifact",
    subject_id: artifactId,
    payload: { type: input.type || "artifact", name: input.name || artifactId, storage_ref: normalizedRef },
    correlation_id: input.correlation_id,
  });
  return normalizeArtifact(dbStore.getDb().prepare("SELECT * FROM platform_artifacts WHERE artifact_id = ?").get(artifactId));
}

function getArtifactLegacy(artifactId) {
  ensurePlatformKernelSchema();
  return normalizeArtifact(dbStore.getDb().prepare("SELECT * FROM platform_artifacts WHERE artifact_id = ?").get(String(artifactId)));
}

function listArtifactsLegacy(query = {}) {
  ensurePlatformKernelSchema();
  const conditions = ["deleted_at IS NULL"];
  const params = [];
  if (query.project_id) { conditions.push("project_id = ?"); params.push(String(query.project_id)); }
  if (query.execution_id) { conditions.push("execution_id = ?"); params.push(String(query.execution_id)); }
  if (query.custody_role) {
    if (!["original", "derivative"].includes(query.custody_role)) throw new Error("Invalid custody_role");
    conditions.push("json_extract(lineage_json, '$.role') = ?");
    params.push(query.custody_role);
  }
  const limit = Math.max(1, Math.min(Number(query.limit) || 50, 100));
  return dbStore.getDb().prepare(`SELECT * FROM platform_artifacts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...params, limit).map(normalizeArtifact);
}

const artifactStore = createArtifactStore({ ensureSchema: ensurePlatformKernelSchema, dbStore, normalizeArtifact, nowIso, newId, json, appendEvent });
const { registerArtifact, getArtifact, listArtifacts } = artifactStore;

function findActiveExecutionLegacy(query = {}) {
  ensurePlatformKernelSchema();
  const conditions = ["state NOT IN ('completed','partial','failed','cancelled','timed_out','rolled_back','rollback_failed')"];
  const params = [];
  if (query.operation_type) { conditions.push("operation_type = ?"); params.push(query.operation_type); }
  if (query.tool_name) { conditions.push("tool_name = ?"); params.push(query.tool_name); }
  if (query.project_id) { conditions.push("project_id = ?"); params.push(query.project_id); }
  if (query.session_id) { conditions.push("session_id = ?"); params.push(query.session_id); }
  if (query.task_id) { conditions.push("task_id = ?"); params.push(query.task_id); }
  if (query.dedupe_key) {
    conditions.push("execution_id IN (SELECT execution_id FROM platform_execution_events WHERE dedupe_key = ?)");
    params.push(query.dedupe_key);
  }
  if (query.metadata_key && query.metadata_value) {
    conditions.push("json_extract(metadata_json, ?) = ?");
    params.push(`$.${query.metadata_key}`, query.metadata_value);
  }
  const where = conditions.join(" AND ");
  const rows = dbStore.getDb().prepare(`SELECT * FROM platform_executions WHERE ${where} ORDER BY updated_at DESC LIMIT 10`).all(...params);
  return rows.map(normalizeExecution);
}

function platformGuardLegacy(executionId, expectedState, options = {}) {
  ensurePlatformKernelSchema();
  if (options.capability && options.actor_id) {
    const cap = checkCapability(options.actor_id, options.capability, options.project_id);
    if (!cap) return { allowed: false, reason: "missing_capability", capability: options.capability, actor_id: options.actor_id };
  }
  if (executionId) {
    const execution = getExecution(executionId);
    if (!execution) return { allowed: false, reason: "execution_not_found", execution: null };
    if (expectedState && execution.state !== expectedState) {
      return { allowed: false, reason: "wrong_state", expected: expectedState, actual: execution.state, execution };
    }
    if (TERMINAL_STATES.has(execution.state) && !options.allowTerminal) {
      return { allowed: false, reason: "terminal_state", actual: execution.state, execution };
    }
    return { allowed: true, execution };
  }
  if (options.operation_type || options.tool_name) {
    const active = findActiveExecution({
      operation_type: options.operation_type,
      tool_name: options.tool_name,
      project_id: options.project_id,
      session_id: options.session_id,
      dedupe_key: options.dedupe_key,
      metadata_key: options.metadata_key,
      metadata_value: options.metadata_value,
    });
    if (active.length > 0 && !options.allowConcurrent) {
      return { allowed: false, reason: "concurrent_execution", active, execution: active[0] };
    }
    return { allowed: true, execution: null, active };
  }
  return { allowed: true, execution: null };
}

const executionGuards = createExecutionGuards({
  ensureSchema: ensurePlatformKernelSchema,
  dbStore,
  normalizeExecution,
  terminalStates: TERMINAL_STATES,
  checkCapability: (actorId, capability, projectId) => checkCapability(actorId, capability, projectId),
  getExecution,
});
const { findActiveExecution, platformGuard } = executionGuards;

function grantCapability(input = {}) {
  ensurePlatformKernelSchema();
  const capId = input.capability_id || newId("cap");
  const ts = input.granted_at || nowIso();
  const projectId = input.project_id == null ? null : normalizeProjectId(input.project_id);
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO platform_capabilities (capability_id, actor_id, capability, project_id, granted_by, granted_at, expires_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(capId, input.actor_id, input.capability, projectId, input.granted_by || null, ts, input.expires_at || null, json(input.metadata || {}));
  appendEvent({
    event_type: "capability.granted",
    source: input.source || "platform",
    actor_id: input.granted_by || "system",
    subject_type: "capability",
    subject_id: capId,
    project_id: projectId,
    payload: { actor_id: input.actor_id, capability: input.capability, expires_at: input.expires_at || null },
    correlation_id: capId,
  });
  return db.prepare("SELECT * FROM platform_capabilities WHERE capability_id = ?").get(capId);
}

function revokeCapability(capabilityId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.revoked_at || nowIso();
  const cap = dbStore.getDb().prepare("SELECT * FROM platform_capabilities WHERE capability_id = ?").get(capabilityId);
  if (!cap) return null;
  dbStore.getDb().prepare("UPDATE platform_capabilities SET revoked_at = ? WHERE capability_id = ? AND revoked_at IS NULL").run(ts, capabilityId);
  appendEvent({
    event_type: "capability.revoked",
    source: details.source || "platform",
    actor_id: details.revoked_by || "system",
    subject_type: "capability",
    subject_id: capabilityId,
    project_id: cap.project_id,
    payload: { actor_id: cap.actor_id, capability: cap.capability, reason: details.reason || null },
    correlation_id: capabilityId,
  });
  return dbStore.getDb().prepare("SELECT * FROM platform_capabilities WHERE capability_id = ?").get(capabilityId);
}

function checkCapability(actorId, capability, projectId) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  const canonicalProjectId = projectId == null ? null : normalizeProjectId(projectId);
  const conditions = ["actor_id = ?", "capability = ?", "revoked_at IS NULL"];
  const params = [actorId, capability];
  if (canonicalProjectId) { conditions.push("(project_id = ? OR project_id IS NULL)"); params.push(canonicalProjectId); }
  else { conditions.push("project_id IS NULL"); }
  conditions.push("(expires_at IS NULL OR expires_at > ?)");
  params.push(ts);
  const cap = dbStore.getDb().prepare(`SELECT * FROM platform_capabilities WHERE ${conditions.join(" AND ")} LIMIT 1`).get(...params);
  return cap || null;
}

function createChangeSet(input = {}) {
  ensurePlatformKernelSchema();
  const changeSetId = input.change_set_id || newId("cs");
  const ts = input.created_at || nowIso();
  const contentHash = input.content_hash || crypto.createHash("sha256").update(JSON.stringify({
    tool_name: input.tool_name || null,
    tool_action: input.tool_action || null,
    operation_type: input.operation_type || "approval",
    actor_id: input.actor_id,
    decision: input.decision,
    args: input.args || {},
  })).digest("hex");
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO platform_change_sets (
      change_set_id, execution_id, approval_id, tool_name, tool_action, operation_type,
      state, content_hash, previous_hash, actor_id, decision, reason,
      args_snapshot_json, result_summary, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    changeSetId, input.execution_id || null, input.approval_id, input.tool_name || null,
    input.tool_action || null, input.operation_type || "approval", input.state || "approved",
    contentHash, input.previous_hash || null, input.actor_id, input.decision,
    input.reason || null, json(input.args || {}), input.result_summary || null,
    ts, json(input.metadata || {})
  );
  appendEvent({
    event_type: `changeset.${input.decision || "approved"}`,
    source: input.source || "platform",
    actor_id: input.actor_id,
    subject_type: "change_set",
    subject_id: changeSetId,
    execution_id: input.execution_id || null,
    project_id: input.project_id || null,
    payload: { approval_id: input.approval_id, tool_name: input.tool_name, decision: input.decision, content_hash: contentHash },
    correlation_id: changeSetId,
  });
  return dbStore.getDb().prepare("SELECT * FROM platform_change_sets WHERE change_set_id = ?").get(changeSetId);
}

function verifyChangeSet(changeSetId) {
  ensurePlatformKernelSchema();
  const cs = dbStore.getDb().prepare("SELECT * FROM platform_change_sets WHERE change_set_id = ?").get(changeSetId);
  if (!cs) return { valid: false, reason: "not_found" };
  const recomputed = crypto.createHash("sha256").update(JSON.stringify({
    tool_name: cs.tool_name,
    tool_action: cs.tool_action,
    operation_type: cs.operation_type,
    actor_id: cs.actor_id,
    decision: cs.decision,
    args: JSON.parse(cs.args_snapshot_json || "{}"),
  })).digest("hex");
  if (recomputed !== cs.content_hash) return { valid: false, reason: "hash_mismatch", expected: recomputed, actual: cs.content_hash, change_set: cs };
  return { valid: true, change_set: cs };
}

function getChangeSetsByApproval(approvalId) {
  ensurePlatformKernelSchema();
  return dbStore.getDb().prepare("SELECT * FROM platform_change_sets WHERE approval_id = ? ORDER BY created_at ASC").all(approvalId);
}

function createWorkflow(input = {}) {
  ensurePlatformKernelSchema();
  const workflowId = input.workflow_id || newId("wf");
  const ts = input.created_at || nowIso();
  const steps = input.steps || [];
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO platform_workflows (workflow_id, name, description, state, current_step, total_steps, execution_id, project_id, created_by, requested_by_principal_id, actor_principal_id, acting_for_principal_id, executed_by_principal_id, created_at, updated_at, checkpoint_json, metadata_json)
    VALUES (?, ?, ?, 'defined', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workflowId, input.name || "unnamed", input.description || null, steps.length, input.execution_id || null, input.project_id || null, input.created_by || null, input.requested_by_principal_id || null, input.actor_principal_id || null, input.acting_for_principal_id || null, input.executed_by_principal_id || null, ts, ts, json(input.checkpoint || {}), json(input.metadata || {}));
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepId = step.step_id || newId("ws");
    db.prepare(`
      INSERT INTO platform_workflow_steps (step_id, workflow_id, step_index, name, tool_name, tool_action, args_json, state, max_retries, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(stepId, workflowId, i, step.name || `step_${i}`, step.tool_name || null, step.tool_action || null, json(step.args || {}), step.max_retries || 0, json(step.metadata || {}));
  }
  appendEvent({ event_type: "workflow.created", source: input.source || "platform", actor_id: input.created_by, execution_id: input.execution_id || null, project_id: input.project_id, subject_type: "workflow", subject_id: workflowId, payload: { name: input.name, total_steps: steps.length }, correlation_id: workflowId });
  return getWorkflow(workflowId);
}

function getWorkflow(workflowId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_workflows WHERE workflow_id = ?").get(workflowId);
  if (!row) return null;
  const steps = dbStore.getDb().prepare("SELECT * FROM platform_workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC").all(workflowId);
  return { ...row, checkpoint: parseJson(row.checkpoint_json, {}), metadata: parseJson(row.metadata_json, {}), steps: steps.map(s => ({ ...s, args: parseJson(s.args_json, {}), metadata: parseJson(s.metadata_json, {}) })) };
}

function startWorkflow(workflowId, details = {}) {
  ensurePlatformKernelSchema();
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error(`Workflow not found: ${workflowId}`);
  if (wf.state !== "defined" && wf.state !== "paused") throw new Error(`Workflow ${workflowId} cannot be started from state ${wf.state}`);
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_workflows SET state = 'running', updated_at = ? WHERE workflow_id = ?").run(ts, workflowId);
  appendEvent({ event_type: "workflow.started", source: details.source || "platform", actor_id: details.actor_id, execution_id: wf.execution_id, project_id: wf.project_id, subject_type: "workflow", subject_id: workflowId, payload: { name: wf.name }, correlation_id: workflowId });
  return getWorkflow(workflowId);
}

function advanceWorkflow(workflowId, details = {}) {
  ensurePlatformKernelSchema();
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error(`Workflow not found: ${workflowId}`);
  if (wf.state !== "running") throw new Error(`Workflow ${workflowId} is not running (state: ${wf.state})`);
  const ts = details.timestamp || nowIso();
  const nextStep = wf.current_step;
  if (nextStep >= wf.total_steps) {
    dbStore.getDb().prepare("UPDATE platform_workflows SET state = 'completed', current_step = ?, completed_at = ?, updated_at = ? WHERE workflow_id = ?").run(nextStep, ts, ts, workflowId);
    appendEvent({ event_type: "workflow.completed", source: details.source || "platform", actor_id: details.actor_id, execution_id: wf.execution_id, project_id: wf.project_id, subject_type: "workflow", subject_id: workflowId, payload: { name: wf.name, total_steps: wf.total_steps }, correlation_id: workflowId });
    return getWorkflow(workflowId);
  }
  const steps = wf.steps || [];
  const step = steps[nextStep];
  if (!step) throw new Error(`Step ${nextStep} not found in workflow ${workflowId}`);
  dbStore.getDb().prepare("UPDATE platform_workflow_steps SET state = 'running', started_at = ? WHERE step_id = ?").run(ts, step.step_id);
  appendEvent({ event_type: "workflow.step_started", source: details.source || "platform", actor_id: details.actor_id, execution_id: wf.execution_id, project_id: wf.project_id, subject_type: "workflow_step", subject_id: step.step_id, payload: { workflow_id: workflowId, step_index: nextStep, name: step.name, tool_name: step.tool_name }, correlation_id: workflowId });
  return getWorkflow(workflowId);
}

function completeWorkflowStep(workflowId, stepId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  const success = !details.error;
  dbStore.getDb().prepare("UPDATE platform_workflow_steps SET state = ?, completed_at = ?, result_summary = ?, error_category = ? WHERE step_id = ?").run(success ? "completed" : "failed", ts, details.result_summary || null, details.error_category || null, stepId);
  appendEvent({ event_type: success ? "workflow.step_completed" : "workflow.step_failed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "workflow_step", subject_id: stepId, payload: { workflow_id: workflowId, step_id: stepId, success }, correlation_id: workflowId });
  // `advance` lets a caller record a step as FAILED without stalling the
  // workflow cursor. A workflow definition may declare a step as tolerated
  // (on_error: "continue"); its durable record must still say it failed, but
  // the run legitimately continues past it. Without this the step row and the
  // cursor could not both be accurate.
  if (success || (details.error && details.advance)) {
    const wf = getWorkflow(workflowId);
    const nextStep = (wf.current_step || 0) + 1;
    if (nextStep >= wf.total_steps) {
      dbStore.getDb().prepare("UPDATE platform_workflows SET state = 'completed', current_step = ?, completed_at = ?, updated_at = ? WHERE workflow_id = ?").run(nextStep, ts, ts, workflowId);
      appendEvent({ event_type: "workflow.completed", source: details.source || "platform", actor_id: details.actor_id, execution_id: wf.execution_id, project_id: wf.project_id, subject_type: "workflow", subject_id: workflowId, payload: { name: wf.name, total_steps: wf.total_steps }, correlation_id: workflowId });
    } else {
      dbStore.getDb().prepare("UPDATE platform_workflows SET current_step = ?, updated_at = ? WHERE workflow_id = ?").run(nextStep, ts, workflowId);
    }
  } else if (details.error && details.shouldRetry) {
    dbStore.getDb().prepare("UPDATE platform_workflow_steps SET state = 'pending', retry_count = retry_count + 1 WHERE step_id = ?").run(stepId);
  }
  return getWorkflow(workflowId);
}

function checkpointWorkflow(workflowId, checkpoint = {}, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_workflows SET checkpoint_json = ?, updated_at = ? WHERE workflow_id = ?").run(json(checkpoint), ts, workflowId);
  appendEvent({ event_type: "workflow.checkpointed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "workflow", subject_id: workflowId, payload: { checkpoint_keys: Object.keys(checkpoint) }, correlation_id: workflowId });
  return getWorkflow(workflowId);
}

function pauseWorkflow(workflowId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_workflows SET state = 'paused', updated_at = ? WHERE workflow_id = ?").run(ts, workflowId);
  appendEvent({ event_type: "workflow.paused", source: details.source || "platform", actor_id: details.actor_id, subject_type: "workflow", subject_id: workflowId, payload: {}, correlation_id: workflowId });
  return getWorkflow(workflowId);
}

function failWorkflow(workflowId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_workflows SET state = 'failed', failed_at = ?, updated_at = ? WHERE workflow_id = ?").run(ts, ts, workflowId);
  appendEvent({ event_type: "workflow.failed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "workflow", subject_id: workflowId, payload: { reason: details.reason || null }, severity: "error", correlation_id: workflowId });
  return getWorkflow(workflowId);
}

function createRunnerSession(input = {}) {
  ensurePlatformKernelSchema();
  const runnerId = input.runner_id || newId("run");
  const ts = input.started_at || nowIso();
  dbStore.getDb().prepare(`
    INSERT INTO platform_runner_sessions (runner_id, execution_id, workflow_id, state, resource_limits_json, started_at, metadata_json,
      requested_by_principal_id, actor_principal_id, acting_for_principal_id, executed_by_principal_id)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
  `).run(runnerId, input.execution_id || null, input.workflow_id || null, json(input.resource_limits || {}), ts, json(input.metadata || {}),
    input.requested_by_principal_id || null, input.actor_principal_id || null, input.acting_for_principal_id || null, input.executed_by_principal_id || input.actor_principal_id || null);
  appendEvent({ event_type: "runner.created", source: input.source || "platform", actor_id: input.actor_id, execution_id: input.execution_id || null, subject_type: "runner", subject_id: runnerId, payload: { workflow_id: input.workflow_id || null }, correlation_id: runnerId });
  return dbStore.getDb().prepare("SELECT * FROM platform_runner_sessions WHERE runner_id = ?").get(runnerId);
}

function updateRunnerHeartbeat(runnerId, usage = {}) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  dbStore.getDb().prepare("UPDATE platform_runner_sessions SET heartbeat_at = ?, resource_usage_json = ? WHERE runner_id = ? AND state = 'active'").run(ts, json(usage), runnerId);
  return dbStore.getDb().prepare("SELECT * FROM platform_runner_sessions WHERE runner_id = ?").get(runnerId);
}

function completeRunnerSession(runnerId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_runner_sessions SET state = 'completed', completed_at = ? WHERE runner_id = ?").run(ts, runnerId);
  appendEvent({ event_type: "runner.completed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "runner", subject_id: runnerId, payload: {}, correlation_id: runnerId });
  return dbStore.getDb().prepare("SELECT * FROM platform_runner_sessions WHERE runner_id = ?").get(runnerId);
}

function terminateRunnerSession(runnerId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_runner_sessions SET state = 'terminated', completed_at = ?, terminated_reason = ? WHERE runner_id = ?").run(ts, details.reason || "terminated", runnerId);
  appendEvent({ event_type: "runner.terminated", source: details.source || "platform", actor_id: details.actor_id, subject_type: "runner", subject_id: runnerId, payload: { reason: details.reason || "terminated" }, severity: "warning", correlation_id: runnerId });
  return dbStore.getDb().prepare("SELECT * FROM platform_runner_sessions WHERE runner_id = ?").get(runnerId);
}

function getRunnerSession(runnerId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_runner_sessions WHERE runner_id = ?").get(runnerId);
  if (!row) return null;
  return { ...row, resource_limits: parseJson(row.resource_limits_json, {}), resource_usage: parseJson(row.resource_usage_json, {}), metadata: parseJson(row.metadata_json, {}) };
}

// --- Execution claims (Phase 4/B contract) ---
//
// One claimant of record per execution, write-fenced by claim_epoch, modeled
// on the approval-continuation and Compute claim patterns. Claims are advisory
// for schedulers: the kernel does not dispatch anything, it only guarantees
// that of N concurrent runners exactly one wins the claim, that a stale
// claimant cannot write after being superseded, and that expired leases are
// recoverable. Checkpoint payloads are caller-defined progress markers and
// must not contain secret material.

const DEFAULT_CLAIM_LEASE_MS = 300000;
const MAX_CLAIM_LEASE_MS = 86400000;

// Bounds matter: a negative lease is born expired (two live "winners"), and a
// huge one overflows into extended ISO years ("+033715-...") whose leading "+"
// sorts before every normal year, silently inverting every lease comparison.
function normalizeLeaseMs(leaseMs) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > MAX_CLAIM_LEASE_MS) {
    throw new Error(`lease_ms must be an integer between 1000 and ${MAX_CLAIM_LEASE_MS}`);
  }
  return leaseMs;
}

function normalizeClaim(row) {
  if (!row) return null;
  const { checkpoint_json, ...rest } = row;
  return { ...rest, cancel_requested: row.cancel_requested === 1, checkpoint: parseJson(checkpoint_json, {}) };
}

function claimExecution({ execution_id, claimed_by, lease_ms = DEFAULT_CLAIM_LEASE_MS } = {}) {
  ensurePlatformKernelSchema();
  if (!execution_id) throw new Error("execution_id is required");
  if (!claimed_by || typeof claimed_by !== "string") throw new Error("claimed_by is required");
  normalizeLeaseMs(lease_ms);
  const db = dbStore.getDb();
  const attempt = db.transaction(() => {
    const exec = db.prepare("SELECT state FROM platform_executions WHERE execution_id = ?").get(execution_id);
    if (!exec) return { ok: false, code: "execution_not_found" };
    if (TERMINAL_STATES.has(exec.state)) return { ok: false, code: "execution_terminal", state: exec.state };
    const now = nowIso();
    const leaseUntil = new Date(Date.now() + lease_ms).toISOString();
    const row = db.prepare("SELECT * FROM platform_execution_claims WHERE execution_id = ?").get(execution_id);
    if (!row) {
      db.prepare("INSERT INTO platform_execution_claims (execution_id, claimed_by, claim_epoch, lease_expires_at, heartbeat_at, cancel_requested, checkpoint_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 0, '{}', ?, ?)").run(execution_id, claimed_by, leaseUntil, now, now, now);
    } else {
      const result = db.prepare("UPDATE platform_execution_claims SET claimed_by = ?, claim_epoch = claim_epoch + 1, lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE execution_id = ? AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)").run(claimed_by, leaseUntil, now, now, execution_id, now);
      if (result.changes === 0) return { ok: false, code: "claim_held", claimed_by: row.claimed_by, lease_expires_at: row.lease_expires_at };
    }
    db.prepare("UPDATE platform_executions SET heartbeat_at = ?, updated_at = ? WHERE execution_id = ?").run(now, now, execution_id);
    return { ok: true, claim: normalizeClaim(db.prepare("SELECT * FROM platform_execution_claims WHERE execution_id = ?").get(execution_id)) };
  });
  return attempt.immediate();
}

function renewExecutionLease({ execution_id, claimed_by, claim_epoch, lease_ms = DEFAULT_CLAIM_LEASE_MS } = {}) {
  ensurePlatformKernelSchema();
  if (!execution_id || !claimed_by || !Number.isInteger(claim_epoch)) throw new Error("execution_id, claimed_by and claim_epoch are required");
  normalizeLeaseMs(lease_ms);
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + lease_ms).toISOString();
  const result = dbStore.getDb().prepare("UPDATE platform_execution_claims SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE execution_id = ? AND claimed_by = ? AND claim_epoch = ?").run(leaseUntil, now, now, execution_id, claimed_by, claim_epoch);
  if (result.changes === 0) return { ok: false, code: "lease_superseded" };
  dbStore.getDb().prepare("UPDATE platform_executions SET heartbeat_at = ?, updated_at = ? WHERE execution_id = ?").run(now, now, execution_id);
  return { ok: true, lease_expires_at: leaseUntil };
}

function checkpointExecution({ execution_id, claimed_by, claim_epoch, checkpoint } = {}) {
  ensurePlatformKernelSchema();
  if (!execution_id || !claimed_by || !Number.isInteger(claim_epoch)) throw new Error("execution_id, claimed_by and claim_epoch are required");
  const now = nowIso();
  const result = dbStore.getDb().prepare("UPDATE platform_execution_claims SET checkpoint_json = ?, heartbeat_at = ?, updated_at = ? WHERE execution_id = ? AND claimed_by = ? AND claim_epoch = ?").run(json(checkpoint), now, now, execution_id, claimed_by, claim_epoch);
  if (result.changes === 0) return { ok: false, code: "checkpoint_rejected" };
  return { ok: true };
}

function releaseExecutionClaim({ execution_id, claimed_by, claim_epoch } = {}) {
  ensurePlatformKernelSchema();
  if (!execution_id || !claimed_by || !Number.isInteger(claim_epoch)) throw new Error("execution_id, claimed_by and claim_epoch are required");
  const now = nowIso();
  const result = dbStore.getDb().prepare("UPDATE platform_execution_claims SET claimed_by = NULL, lease_expires_at = NULL, heartbeat_at = ?, updated_at = ? WHERE execution_id = ? AND claimed_by = ? AND claim_epoch = ?").run(now, now, execution_id, claimed_by, claim_epoch);
  if (result.changes === 0) return { ok: false, code: "release_rejected" };
  return { ok: true };
}

function getExecutionClaim(executionId) {
  ensurePlatformKernelSchema();
  if (!executionId) throw new Error("execution_id is required");
  return normalizeClaim(dbStore.getDb().prepare("SELECT * FROM platform_execution_claims WHERE execution_id = ?").get(executionId));
}

function requestExecutionCancel(executionId, details = {}) {
  ensurePlatformKernelSchema();
  if (!executionId) throw new Error("execution_id is required");
  const exec = dbStore.getDb().prepare("SELECT execution_id FROM platform_executions WHERE execution_id = ?").get(executionId);
  if (!exec) throw new Error(`Execution not found: ${executionId}`);
  const now = nowIso();
  dbStore.getDb().prepare("INSERT INTO platform_execution_claims (execution_id, claim_epoch, cancel_requested, checkpoint_json, created_at, updated_at) VALUES (?, 0, 1, '{}', ?, ?) ON CONFLICT(execution_id) DO UPDATE SET cancel_requested = 1, updated_at = excluded.updated_at").run(executionId, now, now);
  appendEvent({ event_type: "execution.cancel_requested", source: details.source || "platform", actor_id: details.actor_id || null, execution_id: executionId, payload: { reason: details.reason || null }, correlation_id: executionId });
  return { execution_id: executionId, cancel_requested: true };
}

function recoverOrphanedExecutions(details = {}) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const now = details.now || nowIso();
  const rows = db.prepare("SELECT c.execution_id, c.claimed_by, c.lease_expires_at, e.state FROM platform_execution_claims c JOIN platform_executions e ON e.execution_id = c.execution_id WHERE c.claimed_by IS NOT NULL AND c.lease_expires_at IS NOT NULL AND c.lease_expires_at < ?").all(now);
  const orphaned = [];
  const released = [];
  const clear = db.prepare("UPDATE platform_execution_claims SET claimed_by = NULL, lease_expires_at = NULL, updated_at = ? WHERE execution_id = ? AND lease_expires_at IS NOT NULL AND lease_expires_at < ?");
  for (const row of rows) {
    const cleared = clear.run(nowIso(), row.execution_id, now);
    if (cleared.changes === 0) continue;
    if (["queued", "running", "waiting"].includes(row.state)) {
      transitionExecution(row.execution_id, "orphaned", { source: details.source || "platform", actor_id: details.actor_id || null, reason: `claim lease expired (was claimed by ${row.claimed_by})` });
      orphaned.push(row.execution_id);
    } else {
      released.push(row.execution_id);
    }
  }
  if (orphaned.length > 0 || released.length > 0) {
    appendEvent({ event_type: "execution.claims_recovered", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "execution", subject_id: "*", payload: { orphaned: orphaned.length, released: released.length }, correlation_id: details.correlation_id || null });
  }
  return { scanned: rows.length, orphaned, released };
}

function createProjectWorkspace(input = {}) {
  ensurePlatformKernelSchema();
  // Secrets are fully validated (including their stored string form) before
  // the workspace row exists, and the row + envelopes commit in one
  // transaction, so a bad entry, a missing key, or a mid-loop failure cannot
  // leave a half-provisioned workspace behind. secrets_json stays empty for
  // new rows — values live only as envelopes.
  if (input.secrets !== undefined && (typeof input.secrets !== "object" || input.secrets === null || Array.isArray(input.secrets))) {
    throw new Error("secrets must be an object of name/value pairs");
  }
  const secretEntries = [];
  for (const [name, value] of Object.entries(input.secrets || {})) {
    if (!name || typeof name !== "string") throw new Error("secret name is required");
    const stored = value == null || typeof value === "string" ? value : JSON.stringify(value);
    if (stored == null) throw new Error("secret value is required");
    secretEntries.push([name, stored]);
  }
  if (secretEntries.length > 0 && !hasSecretKey()) throw new Error("SIDEKICK_SECRET_KEY not set in .env");
  // Canonicalize through the registry choke point so a workspace row's
  // project_id can never fork from the canonical project identity. Null
  // passthrough preserved (a workspace without a project is legal).
  const projectId = input.project_id == null ? null : normalizeProjectId(input.project_id);
  const ts = nowIso();
  const wsId = newId("ws");
  dbStore.getDb().transaction(() => {
    dbStore.getDb().prepare("INSERT INTO platform_project_workspaces (workspace_id, name, project_id, owner_id, state, config_json, secrets_json, environment, resource_limits_json, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, 'active', ?, '{}', ?, ?, ?, ?, ?)").run(wsId, input.name || projectId, projectId, input.owner_id || "system", json(input.config), input.environment || "default", json(input.resource_limits), ts, ts, json(input.metadata));
    appendEvent({ event_type: "workspace.created", source: input.source || "platform", actor_id: input.actor_id || input.owner_id, subject_type: "workspace", subject_id: wsId, project_id: projectId, payload: { name: input.name || projectId }, correlation_id: wsId });
    for (const [name, stored] of secretEntries) {
      setWorkspaceSecret(wsId, name, stored, { source: input.source, actor_id: input.actor_id || input.owner_id });
    }
  })();
  return getProjectWorkspace(wsId);
}

function getProjectWorkspace(workspaceId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
  return normalizeWorkspace(row, row ? getWorkspaceSecretNames(workspaceId) : []);
}

function getWorkspaceByProject(projectId) {
  ensurePlatformKernelSchema();
  // Rows are stored canonical (createProjectWorkspace normalizes), so the
  // lookup canonicalizes too: casing variants resolve to the same workspace.
  const pid = projectId == null ? null : normalizeProjectId(projectId);
  const row = dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE project_id = ? AND state = 'active'").get(pid);
  return normalizeWorkspace(row, row ? getWorkspaceSecretNames(row.workspace_id) : []);
}

function listProjectWorkspaces(filters = {}) {
  ensurePlatformKernelSchema();
  const conditions = [];
  const params = [];
  if (filters.state) { conditions.push("state = ?"); params.push(String(filters.state)); }
  if (filters.project_id) { conditions.push("project_id = ?"); params.push(normalizeProjectId(filters.project_id)); }
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  const rows = dbStore.getDb().prepare(`SELECT * FROM platform_project_workspaces ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
  // Secret NAMES only — normalizeWorkspace never returns values or envelopes.
  return rows.map(row => normalizeWorkspace(row, getWorkspaceSecretNames(row.workspace_id)));
}

function updateProjectWorkspace(workspaceId, updates = {}) {
  ensurePlatformKernelSchema();
  if (updates.secrets !== undefined) throw new Error("Workspace secrets are managed via setWorkspaceSecret/deleteWorkspaceSecret");
  const ts = nowIso();
  const existing = dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
  if (!existing) throw new Error(`Workspace ${workspaceId} not found`);
  const config = updates.config !== undefined ? json(updates.config) : existing.config_json;
  const environment = updates.environment || existing.environment;
  const resourceLimits = updates.resource_limits !== undefined ? json(updates.resource_limits) : existing.resource_limits_json;
  const metadata = updates.metadata !== undefined ? json(updates.metadata) : existing.metadata_json;
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET config_json = ?, environment = ?, resource_limits_json = ?, metadata_json = ?, updated_at = ? WHERE workspace_id = ?").run(config, environment, resourceLimits, metadata, ts, workspaceId);
  appendEvent({ event_type: "workspace.updated", source: updates.source || "platform", actor_id: updates.actor_id, subject_type: "workspace", subject_id: workspaceId, payload: { updated_fields: Object.keys(updates) }, correlation_id: workspaceId });
  return getProjectWorkspace(workspaceId);
}

function archiveProjectWorkspace(workspaceId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET state = 'archived', archived_at = ?, updated_at = ? WHERE workspace_id = ?").run(ts, ts, workspaceId);
  appendEvent({ event_type: "workspace.archived", source: details.source || "platform", actor_id: details.actor_id, subject_type: "workspace", subject_id: workspaceId, payload: {}, correlation_id: workspaceId });
  return getProjectWorkspace(workspaceId);
}

function registerProject(input = {}) {
  ensurePlatformKernelSchema();
  const original = typeof input.project_id === "string" ? input.project_id.trim() : input.project_id;
  const projectId = normalizeProjectId(input.project_id);
  // Preserve the caller's original spelling when canonicalization changed it,
  // so a display label / audit trail survives the fork fix.
  const canonicalized = typeof original === "string" && original !== projectId;
  const displayName = input.display_name || (canonicalized ? original : projectId);
  const metadata = canonicalized ? { ...(input.metadata || {}), original_project_id: original } : input.metadata;
  const ts = nowIso();
  const result = dbStore.getDb().prepare("INSERT OR IGNORE INTO platform_projects (project_id, display_name, description, owner_actor_id, state, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)").run(projectId, displayName, input.description || null, input.owner_actor_id || null, ts, ts, json(metadata));
  if (result.changes > 0) {
    appendEvent({ event_type: "project.registered", source: input.source || "platform", actor_id: input.owner_actor_id || null, subject_type: "project", subject_id: projectId, payload: { display_name: displayName }, correlation_id: projectId });
  }
  return getProject(projectId);
}

function getProject(projectId) {
  ensurePlatformKernelSchema();
  const pid = normalizeProjectId(projectId);
  const row = dbStore.getDb().prepare("SELECT * FROM platform_projects WHERE project_id = ?").get(pid);
  return normalizeProject(row);
}

function listProjects(filters = {}) {
  ensurePlatformKernelSchema();
  let query = "SELECT * FROM platform_projects WHERE 1=1";
  const params = [];
  if (filters.state) {
    if (!PROJECT_STATES.includes(filters.state)) throw new Error(`Invalid project state: ${filters.state}`);
    query += " AND state = ?";
    params.push(filters.state);
  }
  query += " ORDER BY created_at DESC";
  if (filters.limit) { query += " LIMIT ?"; params.push(filters.limit); }
  return dbStore.getDb().prepare(query).all(...params).map(normalizeProject);
}

function archiveProject(projectId, details = {}) {
  ensurePlatformKernelSchema();
  const pid = normalizeProjectId(projectId);
  const existing = dbStore.getDb().prepare("SELECT * FROM platform_projects WHERE project_id = ?").get(pid);
  if (!existing) throw new Error(`Project ${pid} not found`);
  // Idempotent: re-archiving must not re-stamp timestamps or append a
  // duplicate project.archived audit event.
  if (existing.state === "archived") return normalizeProject(existing);
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_projects SET state = 'archived', archived_at = ?, updated_at = ? WHERE project_id = ?").run(ts, ts, pid);
  appendEvent({ event_type: "project.archived", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "project", subject_id: pid, payload: { reason: details.reason || null }, correlation_id: pid });
  return getProject(pid);
}

function getProjectSource(projectId, source, sourceId) {
  const row = dbStore.getDb().prepare("SELECT * FROM platform_project_sources WHERE project_id = ? AND source = ? AND source_id = ?").get(projectId, source, sourceId);
  return normalizeProjectSource(row);
}

function recordProjectSource(projectId, source, sourceId, details = {}) {
  ensurePlatformKernelSchema();
  const pid = normalizeProjectId(projectId);
  if (!PROJECT_SOURCE_TYPES.includes(source)) throw new Error(`Invalid project source: ${source}`);
  const sid = sourceId == null ? "" : String(sourceId);
  const ts = nowIso();
  const count = Number.isFinite(details.count) ? details.count : 1;
  registerProject({ project_id: pid });
  dbStore.getDb().prepare(`
    INSERT INTO platform_project_sources (project_id, source, source_id, first_seen_at, last_seen_at, count, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, source, source_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, count = count + excluded.count, metadata_json = excluded.metadata_json
  `).run(pid, source, sid, ts, ts, count, json(details.metadata));
  appendEvent({ event_type: "project.source_recorded", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "project", subject_id: pid, payload: { source, source_id: sid }, correlation_id: pid });
  return getProjectSource(pid, source, sid);
}

function getProjectSources(projectId) {
  ensurePlatformKernelSchema();
  const pid = normalizeProjectId(projectId);
  const rows = dbStore.getDb().prepare("SELECT * FROM platform_project_sources WHERE project_id = ? ORDER BY source, source_id").all(pid);
  return rows.map(normalizeProjectSource);
}

function getProjectsBySource(source, sourceId) {
  ensurePlatformKernelSchema();
  if (!PROJECT_SOURCE_TYPES.includes(source)) throw new Error(`Invalid project source: ${source}`);
  const sid = sourceId == null ? "" : String(sourceId);
  const rows = dbStore.getDb().prepare("SELECT * FROM platform_project_sources WHERE source = ? AND source_id = ? ORDER BY last_seen_at DESC").all(source, sid);
  return rows.map(normalizeProjectSource);
}

function backfillProjectSources(details = {}) {
  ensurePlatformKernelSchema();
  // dry_run reports what a real run would register and upsert without
  // touching platform_projects, platform_project_sources, or the event log.
  // The flag is a required boolean so the write path is always deliberately
  // selected — a bare call must not fail open into a real write.
  if (typeof details.dry_run !== "boolean") throw new Error("backfillProjectSources requires details.dry_run (boolean)");
  const dryRun = details.dry_run;
  const ts = details.timestamp || nowIso();
  const scans = [
    { table: "kv_store", projectCol: "project", source: "kv" },
    { table: "memories", projectCol: "project", source: "memory" },
    { table: "platform_executions", projectCol: "project_id", source: "execution" },
    { table: "platform_project_workspaces", projectCol: "project_id", source: "workspace" },
    { table: "compute_jobs", projectCol: "project", source: "compute" },
    { table: "memory_handoffs", projectCol: "project", source: "handoff" },
    { table: "memory_task_sessions", projectCol: "project", source: "session" },
    { table: "blackbox_incidents", projectCol: "project", source: "blackbox" },
    { table: "predictions", projectCol: "project", source: "predict" },
  ];
  const upsert = dbStore.getDb().prepare(`
    INSERT INTO platform_project_sources (project_id, source, source_id, first_seen_at, last_seen_at, count, metadata_json)
    VALUES (?, ?, '*', ?, ?, ?, ?)
    ON CONFLICT(project_id, source, source_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, count = excluded.count, metadata_json = excluded.metadata_json
  `);
  let written = 0;
  const perSource = {};
  const errors = {};
  for (const scan of scans) {
    let rows;
    try {
      rows = dbStore.getDb().prepare(`SELECT ${scan.projectCol} AS project_id, COUNT(*) AS cnt FROM ${scan.table} WHERE ${scan.projectCol} IS NOT NULL AND ${scan.projectCol} != '' GROUP BY ${scan.projectCol}`).all();
    } catch (error) {
      // An unreadable source (missing table, corrupt column, ...) must show up
      // in the report — silently skipping it made a partial backfill look
      // complete.
      errors[scan.source] = { table: scan.table, error: String(error.message || error).slice(0, 300) };
      continue;
    }
    const aggregated = new Map();
    for (const row of rows) {
      const pid = canonicalizeProjectName(String(row.project_id));
      if (pid) aggregated.set(pid, (aggregated.get(pid) || 0) + Number(row.cnt || 0));
    }
    perSource[scan.source] = aggregated.size;
    for (const [pid, count] of aggregated) {
      if (!dryRun) {
        registerProject({ project_id: pid });
        upsert.run(pid, scan.source, ts, ts, count, json({ backfilled_at: ts }));
      }
      written++;
    }
  }
  if (!dryRun) {
    appendEvent({ event_type: "project.sources_backfilled", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "project", subject_id: "*", payload: { written, per_source: perSource, errors }, correlation_id: details.correlation_id || null });
  }
  return { written, sources: perSource, errors, dry_run: dryRun };
}

function setWorkspaceSecret(workspaceId, name, value, details = {}) {
  ensurePlatformKernelSchema();
  if (!workspaceId) throw new Error("workspace_id is required");
  if (!name || typeof name !== "string") throw new Error("secret name is required");
  if (value == null) throw new Error("secret value is required");
  if (!hasSecretKey()) throw new Error("SIDEKICK_SECRET_KEY not set in .env");
  const existing = dbStore.getDb().prepare("SELECT workspace_id FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
  if (!existing) throw new Error(`Workspace ${workspaceId} not found`);
  const ts = nowIso();
  dbStore.getDb().prepare("INSERT INTO platform_workspace_secrets (workspace_id, secret_name, envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, secret_name) DO UPDATE SET envelope_json = excluded.envelope_json, updated_at = excluded.updated_at").run(workspaceId, name, encryptColumn(String(value)), ts, ts);
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET updated_at = ? WHERE workspace_id = ?").run(ts, workspaceId);
  appendEvent({ event_type: "workspace.secret_set", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "workspace", subject_id: workspaceId, payload: { secret_names: [name] }, correlation_id: workspaceId });
  return getProjectWorkspace(workspaceId);
}

function getWorkspaceSecret(workspaceId, name) {
  ensurePlatformKernelSchema();
  if (!workspaceId) throw new Error("workspace_id is required");
  if (!name || typeof name !== "string") throw new Error("secret name is required");
  const row = dbStore.getDb().prepare("SELECT envelope_json FROM platform_workspace_secrets WHERE workspace_id = ? AND secret_name = ?").get(workspaceId, name);
  if (!row) return null;
  if (!hasSecretKey()) throw new Error("SIDEKICK_SECRET_KEY not set in .env");
  return decryptColumn(row.envelope_json);
}

function deleteWorkspaceSecret(workspaceId, name, details = {}) {
  ensurePlatformKernelSchema();
  if (!workspaceId) throw new Error("workspace_id is required");
  if (!name || typeof name !== "string") throw new Error("secret name is required");
  const existing = dbStore.getDb().prepare("SELECT workspace_id FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
  if (!existing) throw new Error(`Workspace ${workspaceId} not found`);
  const result = dbStore.getDb().prepare("DELETE FROM platform_workspace_secrets WHERE workspace_id = ? AND secret_name = ?").run(workspaceId, name);
  if (result.changes === 0) return { workspace_id: workspaceId, deleted: false };
  const ts = nowIso();
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET updated_at = ? WHERE workspace_id = ?").run(ts, workspaceId);
  appendEvent({ event_type: "workspace.secret_deleted", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "workspace", subject_id: workspaceId, payload: { secret_names: [name] }, correlation_id: workspaceId });
  return { workspace_id: workspaceId, deleted: true };
}

function listWorkspaceSecretNames(workspaceId) {
  ensurePlatformKernelSchema();
  if (!workspaceId) throw new Error("workspace_id is required");
  const existing = dbStore.getDb().prepare("SELECT workspace_id FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
  if (!existing) return [];
  return getWorkspaceSecretNames(workspaceId);
}

function backfillWorkspaceSecrets(details = {}) {
  ensurePlatformKernelSchema();
  if (!hasSecretKey()) throw new Error("SIDEKICK_SECRET_KEY not set in .env");
  // Optional report-only mode for the workspace tool surface: scans and
  // classifies exactly like a real run but writes nothing (no envelopes, no
  // plaintext clearing, no event). Defaults to the historical always-write
  // behavior so existing callers are unaffected.
  const dryRun = details.dry_run === true;
  const db = dbStore.getDb();
  const rows = db.prepare("SELECT workspace_id, secrets_json FROM platform_project_workspaces WHERE secrets_json IS NOT NULL AND secrets_json NOT IN ('', '{}', 'null')").all();
  // Envelopes are written before the plaintext is cleared, and existing
  // envelopes win (DO NOTHING), so an interrupted run never loses a secret and
  // a re-run only cleans up whatever plaintext is still left. Plaintext is
  // retained whenever it is the last recoverable copy of anything: an entry
  // whose name the secret API cannot address, or an existing envelope that no
  // longer decrypts under the current key.
  const insert = db.prepare("INSERT INTO platform_workspace_secrets (workspace_id, secret_name, envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, secret_name) DO NOTHING");
  const selectEnvelope = db.prepare("SELECT envelope_json FROM platform_workspace_secrets WHERE workspace_id = ? AND secret_name = ?");
  // The clear re-checks the scanned value so a plaintext write that lands
  // between scan and clear survives for the next run instead of being wiped.
  const clear = db.prepare("UPDATE platform_project_workspaces SET secrets_json = '{}', updated_at = ? WHERE workspace_id = ? AND secrets_json = ?");
  let migrated = 0;
  let skippedExisting = 0;
  let skippedNull = 0;
  let workspacesMigrated = 0;
  const unreadable = [];
  const retained = [];
  for (const row of rows) {
    let secrets;
    try {
      secrets = JSON.parse(row.secrets_json);
    } catch {
      secrets = null;
    }
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
      unreadable.push(row.workspace_id);
      continue;
    }
    const ts = nowIso();
    let retain = false;
    for (const [name, value] of Object.entries(secrets)) {
      if (value == null) {
        skippedNull++;
        continue;
      }
      if (!name) {
        retain = true;
        continue;
      }
      if (dryRun) {
        // Report-only classification: never encrypts or inserts.
        const existingEnvelope = selectEnvelope.get(row.workspace_id, name);
        if (!existingEnvelope) {
          migrated++;
          continue;
        }
        skippedExisting++;
        try {
          decryptColumn(existingEnvelope.envelope_json);
        } catch {
          retain = true;
        }
        continue;
      }
      const plaintext = typeof value === "string" ? value : JSON.stringify(value);
      const result = insert.run(row.workspace_id, name, encryptColumn(plaintext), ts, ts);
      if (result.changes > 0) {
        migrated++;
        continue;
      }
      skippedExisting++;
      try {
        decryptColumn(selectEnvelope.get(row.workspace_id, name).envelope_json);
      } catch {
        retain = true;
      }
    }
    if (retain) {
      retained.push(row.workspace_id);
      continue;
    }
    if (dryRun) {
      workspacesMigrated++;
      continue;
    }
    const cleared = clear.run(ts, row.workspace_id, row.secrets_json);
    if (cleared.changes === 0) {
      retained.push(row.workspace_id);
      continue;
    }
    workspacesMigrated++;
  }
  if (!dryRun) {
    appendEvent({ event_type: "workspace.secrets_backfilled", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "workspace", subject_id: "*", payload: { workspaces_migrated: workspacesMigrated, secrets_migrated: migrated, secrets_skipped_existing: skippedExisting, secrets_skipped_null: skippedNull, workspaces_unreadable: unreadable.length, workspaces_retained: retained.length }, correlation_id: details.correlation_id || null });
  }
  return { workspaces_scanned: rows.length, workspaces_migrated: workspacesMigrated, secrets_migrated: migrated, secrets_skipped_existing: skippedExisting, secrets_skipped_null: skippedNull, workspaces_unreadable: unreadable, workspaces_retained: retained, dry_run: dryRun };
}

/**
 * DEPRECATED — `platform_model_registry` is a second model registry.
 *
 * `compute_models` (via `src/compute/model-registry.js`) is the single model
 * authority: it is what placement ranks, what the inference service dispatches
 * against, and what the provider bootstrap seeds. This table has never had a
 * production caller — only tests — and duplicating model identity across two
 * stores is how the two drift into disagreeing about what exists.
 *
 * These functions are retained (not deleted) so the schema and its tests keep
 * building, and are deliberately NOT bridged to `compute_models`: a sync bridge
 * would make the duplication permanent instead of ending it. Do not add callers.
 * `test/compute-model-dedup.test.js` fails if production code starts using them.
 */
function registerModel(input = {}) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  const modelId = newId("model");
  dbStore.getDb().prepare("INSERT INTO platform_model_registry (model_id, name, provider, version, state, capabilities_json, context_window, max_output_tokens, supports_streaming, supports_vision, supports_tools, cost_per_1k_input, cost_per_1k_output, rate_limit_rpm, registered_by, registered_at, metadata_json) VALUES (?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(modelId, input.name, input.provider, input.version || null, json(input.capabilities), input.context_window || null, input.max_output_tokens || null, input.supports_streaming ? 1 : 0, input.supports_vision ? 1 : 0, input.supports_tools !== false ? 1 : 0, input.cost_per_1k_input || null, input.cost_per_1k_output || null, input.rate_limit_rpm || null, input.registered_by || "system", ts, json(input.metadata));
  appendEvent({ event_type: "model.registered", source: input.source || "platform", actor_id: input.registered_by, subject_type: "model", subject_id: modelId, payload: { name: input.name, provider: input.provider }, correlation_id: modelId });
  return dbStore.getDb().prepare("SELECT * FROM platform_model_registry WHERE model_id = ?").get(modelId);
}

function getModel(modelId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_model_registry WHERE model_id = ?").get(modelId);
  if (!row) return null;
  return { ...row, capabilities: parseJson(row.capabilities_json, []), supports_streaming: !!row.supports_streaming, supports_vision: !!row.supports_vision, supports_tools: !!row.supports_tools, metadata: parseJson(row.metadata_json, {}) };
}

function getModelByName(name, provider) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_model_registry WHERE name = ? AND provider = ?").get(name, provider);
  if (!row) return null;
  return { ...row, capabilities: parseJson(row.capabilities_json, []), supports_streaming: !!row.supports_streaming, supports_vision: !!row.supports_vision, supports_tools: !!row.supports_tools, metadata: parseJson(row.metadata_json, {}) };
}

function listModels(filters = {}) {
  ensurePlatformKernelSchema();
  let query = "SELECT * FROM platform_model_registry WHERE 1=1";
  const params = [];
  if (filters.state) { query += " AND state = ?"; params.push(filters.state); }
  if (filters.provider) { query += " AND provider = ?"; params.push(filters.provider); }
  query += " ORDER BY registered_at DESC";
  if (filters.limit) { query += " LIMIT ?"; params.push(filters.limit); }
  return dbStore.getDb().prepare(query).all(...params).map(row => ({ ...row, capabilities: parseJson(row.capabilities_json, []), supports_streaming: !!row.supports_streaming, supports_vision: !!row.supports_vision, supports_tools: !!row.supports_tools, metadata: parseJson(row.metadata_json, {}) }));
}

function deprecateModel(modelId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_model_registry SET state = 'deprecated', deprecated_at = ? WHERE model_id = ?").run(ts, modelId);
  appendEvent({ event_type: "model.deprecated", source: details.source || "platform", actor_id: details.actor_id, subject_type: "model", subject_id: modelId, payload: { reason: details.reason }, severity: "warning", correlation_id: modelId });
  return dbStore.getDb().prepare("SELECT * FROM platform_model_registry WHERE model_id = ?").get(modelId);
}

function recordModelUsage(modelId) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  dbStore.getDb().prepare("UPDATE platform_model_registry SET usage_count = usage_count + 1, last_used_at = ? WHERE model_id = ?").run(ts, modelId);
  return dbStore.getDb().prepare("SELECT * FROM platform_model_registry WHERE model_id = ?").get(modelId);
}

/**
 * DEPRECATED — `platform_extensions` is a second module-ish lifecycle.
 *
 * `platform_modules` (via `src/modules/`) is the single module authority: it
 * owns managed installation, integrity verification, activation, policy,
 * health, and reconciliation, and capability packs compose on top of it. This
 * extension registry predates that system, has never had a production caller —
 * only tests — and running two parallel lifecycles is how they drift into
 * disagreeing about what is installed and active.
 *
 * These functions are retained (not deleted) so the schema and its tests keep
 * building, and are deliberately NOT bridged to `platform_modules`: a bridge
 * would make the duplication permanent instead of ending it. Do not add
 * callers. `test/deprecated-kernel-surfaces.test.js` fails if production code
 * starts using them.
 */
function registerExtension(input = {}) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  const extId = newId("ext");
  dbStore.getDb().prepare("INSERT INTO platform_extensions (extension_id, name, version, state, type, author, description, entry_point, capabilities_json, dependencies_json, config_schema_json, config_json, hooks_json, registered_at, metadata_json) VALUES (?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(extId, input.name, input.version || "1.0.0", input.type || "plugin", input.author || null, input.description || null, input.entry_point || null, json(input.capabilities), json(input.dependencies), json(input.config_schema), json(input.config), json(input.hooks), ts, json(input.metadata));
  appendEvent({ event_type: "extension.registered", source: input.source || "platform", actor_id: input.author, subject_type: "extension", subject_id: extId, payload: { name: input.name, version: input.version || "1.0.0", type: input.type || "plugin" }, correlation_id: extId });
  return dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = ?").get(extId);
}

function getExtension(extensionId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = ?").get(extensionId);
  if (!row) return null;
  return { ...row, capabilities: parseJson(row.capabilities_json, []), dependencies: parseJson(row.dependencies_json, []), config_schema: parseJson(row.config_schema_json, {}), config: parseJson(row.config_json, {}), hooks: parseJson(row.hooks_json, []), metadata: parseJson(row.metadata_json, {}) };
}

function getExtensionByName(name) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE name = ?").get(name);
  if (!row) return null;
  return { ...row, capabilities: parseJson(row.capabilities_json, []), dependencies: parseJson(row.dependencies_json, []), config_schema: parseJson(row.config_schema_json, {}), config: parseJson(row.config_json, {}), hooks: parseJson(row.hooks_json, []), metadata: parseJson(row.metadata_json, {}) };
}

function activateExtension(extensionId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_extensions SET state = 'active', activated_at = ? WHERE extension_id = ? AND state = 'registered'").run(ts, extensionId);
  appendEvent({ event_type: "extension.activated", source: details.source || "platform", actor_id: details.actor_id, subject_type: "extension", subject_id: extensionId, payload: {}, correlation_id: extensionId });
  return dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = ?").get(extensionId);
}

function deactivateExtension(extensionId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_extensions SET state = 'deactivated', deactivated_at = ? WHERE extension_id = ? AND state = 'active'").run(ts, extensionId);
  appendEvent({ event_type: "extension.deactivated", source: details.source || "platform", actor_id: details.actor_id, subject_type: "extension", subject_id: extensionId, payload: { reason: details.reason }, correlation_id: extensionId });
  return dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = ?").get(extensionId);
}

function uninstallExtension(extensionId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_extensions SET state = 'uninstalled', uninstalled_at = ? WHERE extension_id = ?").run(ts, extensionId);
  appendEvent({ event_type: "extension.uninstalled", source: details.source || "platform", actor_id: details.actor_id, subject_type: "extension", subject_id: extensionId, payload: { reason: details.reason }, severity: "warning", correlation_id: extensionId });
  return dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = ?").get(extensionId);
}

function updateExtensionConfig(extensionId, config = {}) {
  ensurePlatformKernelSchema();
  dbStore.getDb().prepare("UPDATE platform_extensions SET config_json = ? WHERE extension_id = ?").run(json(config), extensionId);
  return dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = ?").get(extensionId);
}

function recordExtensionUsage(extensionId) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  dbStore.getDb().prepare("UPDATE platform_extensions SET usage_count = usage_count + 1, last_used_at = ? WHERE extension_id = ?").run(ts, extensionId);
  return dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = ?").get(extensionId);
}

function listExtensions(filters = {}) {
  ensurePlatformKernelSchema();
  let query = "SELECT * FROM platform_extensions WHERE 1=1";
  const params = [];
  if (filters.state) { query += " AND state = ?"; params.push(filters.state); }
  if (filters.type) { query += " AND type = ?"; params.push(filters.type); }
  query += " ORDER BY registered_at DESC";
  if (filters.limit) { query += " LIMIT ?"; params.push(filters.limit); }
  return dbStore.getDb().prepare(query).all(...params).map(row => ({ ...row, capabilities: parseJson(row.capabilities_json, []), dependencies: parseJson(row.dependencies_json, []), config_schema: parseJson(row.config_schema_json, {}), config: parseJson(row.config_json, {}), hooks: parseJson(row.hooks_json, []), metadata: parseJson(row.metadata_json, {}) }));
}

function generatePlatformDocs() {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const execCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_executions").get().cnt;
  const eventCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_execution_events").get().cnt;
  const artifactCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_artifacts").get().cnt;
  const workflowCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_workflows").get().cnt;
  const runnerCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_runner_sessions").get().cnt;
  const workspaceCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_project_workspaces").get().cnt;
  const modelCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_model_registry").get().cnt;
  const extensionCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_extensions").get().cnt;
  const capabilityCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_capabilities").get().cnt;
  const changeSetCount = db.prepare("SELECT COUNT(*) as cnt FROM platform_change_sets").get().cnt;
  const states = db.prepare("SELECT state, COUNT(*) as cnt FROM platform_executions GROUP BY state ORDER BY cnt DESC").all();
  // '-24h' was not a valid SQLite modifier, so datetime() returned NULL and this
  // matched no rows at all. Bind an ISO bound to match the column's format.
  const recentEvents = db.prepare("SELECT event_type, COUNT(*) as cnt FROM platform_execution_events WHERE timestamp > ? GROUP BY event_type ORDER BY cnt DESC LIMIT 10").all(isoHoursAgo(24));
  const activeModels = db.prepare("SELECT name, provider, usage_count FROM platform_model_registry WHERE state = 'registered' ORDER BY usage_count DESC LIMIT 5").all();
  const activeExtensions = db.prepare("SELECT name, type, state, usage_count FROM platform_extensions WHERE state = 'active' ORDER BY usage_count DESC LIMIT 5").all();
  return {
    generated_at: nowIso(),
    summary: { executions: execCount, events: eventCount, artifacts: artifactCount, workflows: workflowCount, runners: runnerCount, workspaces: workspaceCount, models: modelCount, extensions: extensionCount, capabilities: capabilityCount, change_sets: changeSetCount },
    execution_states: states,
    recent_events_24h: recentEvents,
    active_models: activeModels,
    active_extensions: activeExtensions,
    tables: ["platform_executions", "platform_execution_events", "platform_artifacts", "platform_execution_transitions", "platform_capabilities", "platform_change_sets", "platform_workflows", "platform_workflow_steps", "platform_runner_sessions", "platform_project_workspaces", "platform_model_registry", "platform_extensions", "platform_releases", "platform_backups"],
  };
}

function createBackup(input = {}) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  const backupId = newId("backup");
  const tables = input.tables || ["platform_executions", "platform_execution_events", "platform_artifacts", "platform_execution_transitions", "platform_capabilities", "platform_change_sets", "platform_workflows", "platform_workflow_steps", "platform_runner_sessions", "platform_project_workspaces", "platform_model_registry", "platform_extensions", "platform_releases"];
  const db = dbStore.getDb();
  const rowCounts = {};
  for (const table of tables) {
    // A missing/unreadable table is recorded as such, not as an empty table:
    // a backup manifest claiming 0 rows for a table it never read is the kind
    // of quiet lie that surfaces only during a restore.
    try { rowCounts[table] = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get().cnt; } catch { rowCounts[table] = { error: "unreadable" }; }
  }
  dbStore.getDb().prepare("INSERT INTO platform_backups (backup_id, name, state, type, tables_included_json, row_counts_json, compression, created_at, metadata_json) VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?)").run(backupId, input.name || `backup_${Date.now()}`, input.type || "full", json(tables), json(rowCounts), input.compression || "none", ts, json(input.metadata));
  appendEvent({ event_type: "backup.created", source: input.source || "platform", actor_id: input.actor_id, subject_type: "backup", subject_id: backupId, payload: { name: input.name, type: input.type || "full", table_count: tables.length }, correlation_id: backupId });
  return dbStore.getDb().prepare("SELECT * FROM platform_backups WHERE backup_id = ?").get(backupId);
}

function getBackup(backupId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_backups WHERE backup_id = ?").get(backupId);
  if (!row) return null;
  return { ...row, tables_included: parseJson(row.tables_included_json, []), row_counts: parseJson(row.row_counts_json, {}), metadata: parseJson(row.metadata_json, {}) };
}

function completeBackup(backupId, details = {}) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT backup_id, state FROM platform_backups WHERE backup_id = ?").get(backupId);
  if (!row) throw new Error("backup not found");
  if (row.state !== "created") throw new Error(`backup is not awaiting completion: ${row.state}`);
  if (typeof details.file_path !== "string" || !details.file_path.trim()) throw new Error("file_path is required");
  const backupRoot = fs.realpathSync(path.resolve(dbStore.BACKUP_DIR));
  const lexicalPath = path.resolve(details.file_path);
  if (lexicalPath !== backupRoot && !lexicalPath.startsWith(`${backupRoot}${path.sep}`)) {
    throw new Error("backup file must be inside the managed backup directory");
  }
  const stat = fs.lstatSync(lexicalPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("backup file must be a regular, non-symlink file");
  const resolvedPath = fs.realpathSync(lexicalPath);
  if (resolvedPath !== backupRoot && !resolvedPath.startsWith(`${backupRoot}${path.sep}`)) {
    throw new Error("backup file escaped the managed backup directory");
  }
  const actualStat = fs.statSync(resolvedPath);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(resolvedPath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  const actualSize = actualStat.size;
  const actualChecksum = hash.digest("hex");
  if (details.file_size_bytes !== undefined && Number(details.file_size_bytes) !== actualSize) {
    throw new Error("backup file size does not match the supplied metadata");
  }
  if (details.checksum !== undefined && String(details.checksum).replace(/^sha256:/i, "").toLowerCase() !== actualChecksum) {
    throw new Error("backup checksum does not match the file contents");
  }
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_backups SET state = 'completed', completed_at = ?, file_path = ?, file_size_bytes = ?, checksum = ? WHERE backup_id = ? AND state = 'created'").run(ts, resolvedPath, actualSize, `sha256:${actualChecksum}`, backupId);
  appendEvent({ event_type: "backup.completed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "backup", subject_id: backupId, payload: { file_path: resolvedPath, file_size_bytes: actualSize, checksum: `sha256:${actualChecksum}` }, correlation_id: backupId });
  return dbStore.getDb().prepare("SELECT * FROM platform_backups WHERE backup_id = ?").get(backupId);
}

function restoreBackup(backupId) {
  ensurePlatformKernelSchema();
  // Fail honestly instead of recording fake success. This function never
  // performed a restore: it flipped the row to 'restored' and appended a
  // backup.restored event while touching zero data — an audit trail claiming
  // a recovery that never happened. Until a real kernel restore exists, the
  // supported path is the db_backup/db_restore tools (src/db.js), which
  // actually copy and verify the database file.
  const error = new Error(
    `platform restoreBackup is not supported: no kernel restore implementation exists. ` +
    `Use the db_backup/db_restore tools for real database backup and restore. (backup_id: ${backupId})`
  );
  error.code = "not_supported";
  error.backup_id = String(backupId);
  throw error;
}

function listBackups(filters = {}) {
  ensurePlatformKernelSchema();
  let query = "SELECT * FROM platform_backups WHERE 1=1";
  const params = [];
  if (filters.state) { query += " AND state = ?"; params.push(filters.state); }
  if (filters.type) { query += " AND type = ?"; params.push(filters.type); }
  query += " ORDER BY created_at DESC";
  if (filters.limit) { query += " LIMIT ?"; params.push(filters.limit); }
  return dbStore.getDb().prepare(query).all(...params).map(row => ({ ...row, tables_included: parseJson(row.tables_included_json, []), row_counts: parseJson(row.row_counts_json, {}), metadata: parseJson(row.metadata_json, {}) }));
}

function createRelease(input = {}) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  const releaseId = newId("release");
  dbStore.getDb().prepare("INSERT INTO platform_releases (release_id, version, state, codename, description, changelog_json, migration_version, breaking_changes_json, deprecations_json, upgrade_notes, released_by, created_at, metadata_json) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(releaseId, input.version, input.codename || null, input.description || null, json(input.changelog || []), input.migration_version || null, json(input.breaking_changes || []), json(input.deprecations || []), input.upgrade_notes || null, input.released_by || "system", ts, json(input.metadata));
  appendEvent({ event_type: "release.created", source: input.source || "platform", actor_id: input.released_by, subject_type: "release", subject_id: releaseId, payload: { version: input.version, codename: input.codename }, correlation_id: releaseId });
  return dbStore.getDb().prepare("SELECT * FROM platform_releases WHERE release_id = ?").get(releaseId);
}

function getRelease(releaseId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_releases WHERE release_id = ?").get(releaseId);
  if (!row) return null;
  return { ...row, changelog: parseJson(row.changelog_json, []), breaking_changes: parseJson(row.breaking_changes_json, []), deprecations: parseJson(row.deprecations_json, []), metadata: parseJson(row.metadata_json, {}) };
}

function getReleaseByVersion(version) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_releases WHERE version = ?").get(version);
  if (!row) return null;
  return { ...row, changelog: parseJson(row.changelog_json, []), breaking_changes: parseJson(row.breaking_changes_json, []), deprecations: parseJson(row.deprecations_json, []), metadata: parseJson(row.metadata_json, {}) };
}

function publishRelease(releaseId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_releases SET state = 'published', released_at = ? WHERE release_id = ?").run(ts, releaseId);
  appendEvent({ event_type: "release.published", source: details.source || "platform", actor_id: details.actor_id, subject_type: "release", subject_id: releaseId, payload: {}, correlation_id: releaseId });
  return dbStore.getDb().prepare("SELECT * FROM platform_releases WHERE release_id = ?").get(releaseId);
}

function listReleases(filters = {}) {
  ensurePlatformKernelSchema();
  let query = "SELECT * FROM platform_releases WHERE 1=1";
  const params = [];
  if (filters.state) { query += " AND state = ?"; params.push(filters.state); }
  query += " ORDER BY created_at DESC";
  if (filters.limit) { query += " LIMIT ?"; params.push(filters.limit); }
  return dbStore.getDb().prepare(query).all(...params).map(row => ({ ...row, changelog: parseJson(row.changelog_json, []), breaking_changes: parseJson(row.breaking_changes_json, []), deprecations: parseJson(row.deprecations_json, []), metadata: parseJson(row.metadata_json, {}) }));
}

module.exports = {
  EXECUTION_STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  ensurePlatformKernelSchema,
  validateTransition,
  createExecution,
  getExecution,
  transitionExecution,
  appendEvent,
  registerEventSubscription,
  setEventSubscriptionState,
  listEventSubscriptions,
  enqueueEventDeliveries,
  runWithCausation,
  getAmbientCausationId,
  getEventBacklogCap,
  listClaimableEventDeliveries,
  recoverStaleEventDeliveries,
  claimEventDelivery,
  completeEventDelivery,
  requeueEventDelivery,
  deliverEvent,
  listEventDeliveries,
  getEventDeliveryStats,
  registerConnector,
  getConnector,
  listConnectors,
  listConnectorEvents,
  transitionConnector,
  configureConnector,
  recordConnectorHealth,
  checkConnectorHealth,
  createScopeSnapshot,
  getScopeSnapshot,
  listScopeSnapshots,
  evaluateScope,
  bindExecutionScope,
  createResearchCampaign,
  getResearchCampaign,
  listResearchCampaigns,
  transitionResearchCampaign,
  createResearchHypothesis,
  getResearchHypothesis,
  listResearchHypotheses,
  transitionResearchHypothesis,
  createResearchTestRun,
  getResearchTestRun,
  listResearchTestRuns,
  transitionResearchTestRun,
  createResearchFinding,
  getResearchFinding,
  listResearchFindings,
  createResearchReport,
  getResearchReport,
  listResearchReports,
  createResearchDisclosure,
  getResearchDisclosure,
  listResearchDisclosures,
  transitionResearchDisclosure,
  createResearchSourceRepository,
  getResearchSourceRepository,
  listResearchSourceRepositories,
  createResearchSourceSnapshot,
  getResearchSourceSnapshot,
  listResearchSourceSnapshots,
  transitionResearchSourceRepository,
  transitionResearchSourceSnapshot,
  selectResearchSourceSnapshot,
  removeResearchSourceSnapshot,
  updateResearchSourceSnapshotProvenance,
  markResearchSourceSnapshotVerification,
  createResearchSourceAuthorityClaim,
  getResearchSourceAuthorityClaim,
  listResearchSourceAuthorityClaims,
  transitionResearchSourceAuthorityClaim,
  registerArtifact,
  getArtifact,
  listArtifacts,
  findActiveExecution,
  platformGuard,
  grantCapability,
  revokeCapability,
  checkCapability,
  createChangeSet,
  verifyChangeSet,
  getChangeSetsByApproval,
  createWorkflow,
  getWorkflow,
  startWorkflow,
  advanceWorkflow,
  completeWorkflowStep,
  checkpointWorkflow,
  pauseWorkflow,
  failWorkflow,
  createRunnerSession,
  updateRunnerHeartbeat,
  completeRunnerSession,
  terminateRunnerSession,
  getRunnerSession,
  claimExecution,
  renewExecutionLease,
  checkpointExecution,
  releaseExecutionClaim,
  getExecutionClaim,
  requestExecutionCancel,
  recoverOrphanedExecutions,
  createProjectWorkspace,
  getProjectWorkspace,
  getWorkspaceByProject,
  listProjectWorkspaces,
  updateProjectWorkspace,
  archiveProjectWorkspace,
  registerProject,
  getProject,
  listProjects,
  archiveProject,
  recordProjectSource,
  getProjectSources,
  getProjectsBySource,
  backfillProjectSources,
  setWorkspaceSecret,
  getWorkspaceSecret,
  deleteWorkspaceSecret,
  listWorkspaceSecretNames,
  backfillWorkspaceSecrets,
  registerModel,
  getModel,
  getModelByName,
  listModels,
  deprecateModel,
  recordModelUsage,
  registerExtension,
  getExtension,
  getExtensionByName,
  activateExtension,
  deactivateExtension,
  uninstallExtension,
  updateExtensionConfig,
  recordExtensionUsage,
  listExtensions,
  generatePlatformDocs,
  createBackup,
  getBackup,
  completeBackup,
  restoreBackup,
  listBackups,
  createRelease,
  getRelease,
  getReleaseByVersion,
  publishRelease,
  listReleases,
};
