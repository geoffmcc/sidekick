const crypto = require("crypto");
const path = require("path");
const dbStore = require("../db");
const { redactSensitive } = require("../redact");
const { KERNEL_SCHEMA_SQL } = require("./kernel-schema");
const { ensurePlatformModuleSchema } = require("../modules/schema");
const { encryptColumn, decryptColumn, hasSecretKey } = require("../core/secret-cipher");

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
  const id = projectId.trim();
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
  ensurePlatformModuleSchema();
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
  if (!validateTransition(null, state)) throw new Error(`Execution must start in created state, got ${state}`);
  db.prepare(`
    INSERT INTO platform_executions (
      execution_id, parent_execution_id, root_execution_id, task_id, session_id, workflow_id,
      project_id, incident_id, change_set_id, actor_id, client_id, trigger_type, operation_type,
      tool_name, tool_action, resource_scope, environment, state, risk, approval_state, started_at,
      updated_at, deadline_at, heartbeat_at, trace_id, span_id, schema_version, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    executionId,
    input.parent_execution_id || null,
    rootId,
    input.task_id || null,
    input.session_id || null,
    input.workflow_id || null,
    input.project_id || null,
    input.incident_id || null,
    input.change_set_id || null,
    input.actor_id || null,
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
    project_id: input.project_id,
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
  const event = appendEvent({
    event_type: `execution.${newState}`,
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

function appendEvent(input = {}) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const eventId = input.event_id || newId("evt");
  const payload = input.payload || {};
  const ts = input.timestamp || nowIso();
  try {
    db.prepare(`
      INSERT INTO platform_execution_events (
        event_id, event_type, schema_version, timestamp, source, actor_id, subject_type, subject_id,
        project_id, environment, execution_id, root_execution_id, task_id, session_id, severity,
        payload_json, sensitivity, dedupe_key, causation_id, correlation_id, redaction_state
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.event_type,
      ts,
      input.source || "platform",
      input.actor_id || null,
      input.subject_type || null,
      input.subject_id || null,
      input.project_id || null,
      input.environment || null,
      input.execution_id || null,
      input.root_execution_id || null,
      input.task_id || null,
      input.session_id || null,
      input.severity || "info",
      json(payload),
      input.sensitivity || "normal",
      input.dedupe_key || null,
      input.causation_id || null,
      input.correlation_id || input.root_execution_id || input.execution_id || null,
      input.redaction_state || "redacted"
    );
  } catch (error) {
    if (input.dedupe_key && /UNIQUE constraint failed/.test(error.message)) {
      return db.prepare("SELECT * FROM platform_execution_events WHERE dedupe_key = ?").get(input.dedupe_key);
    }
    throw error;
  }
  try { enqueueEventDeliveries(eventId); } catch {}
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
  const maxAttempts = Number.isInteger(input.max_attempts) ? input.max_attempts : 3;
  if (maxAttempts < 1 || maxAttempts > 20) throw new Error("max_attempts must be between 1 and 20");
  const subscriptionId = input.subscription_id || newId("sub");
  const ts = nowIso();
  dbStore.getDb().prepare(`
    INSERT INTO platform_event_subscriptions
      (subscription_id, name, event_type, state, max_attempts, created_at, updated_at, metadata_json)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(subscriptionId, name, eventType, maxAttempts, ts, ts, json(input.metadata || {}));
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

function enqueueEventDeliveries(eventId) {
  ensurePlatformKernelSchema();
  const db = dbStore.getDb();
  const event = db.prepare("SELECT event_id, event_type FROM platform_execution_events WHERE event_id = ?").get(eventId);
  if (!event) return 0;
  const subscriptions = db.prepare("SELECT * FROM platform_event_subscriptions WHERE state = 'active' AND (event_type = ? OR event_type = '*')").all(event.event_type);
  const ts = nowIso();
  let queued = 0;
  for (const subscription of subscriptions) {
    const result = db.prepare(`
      INSERT OR IGNORE INTO platform_event_deliveries
        (delivery_id, subscription_id, event_id, status, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, 'pending', ?, ?, '{}')
    `).run(newId("delivery"), subscription.subscription_id, event.event_id, ts, ts);
    queued += result.changes;
  }
  return queued;
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

function deliverEvent(deliveryId, handler) {
  if (typeof handler !== "function") throw new Error("delivery handler is required");
  const delivery = claimEventDelivery(deliveryId);
  if (!delivery) return null;
  const event = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_id = ?").get(delivery.event_id);
  event.payload = parseJson(event.payload_json, {});
  try {
    handler(event);
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

function assertConnectorConfigSafe(value, pathName = "config") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(api[_-]?key|access[_-]?token|password|private[_-]?key|webhook[_-]?url|^secret$)/i.test(key) && !/_ref$/i.test(key)) {
      throw new Error(`${pathName}.${key} must use a secret reference, not a credential value`);
    }
    if (child && typeof child === "object") assertConnectorConfigSafe(child, `${pathName}.${key}`);
  }
}

function registerConnector(input = {}) {
  ensurePlatformKernelSchema();
  const name = String(input.name || "").trim();
  const type = String(input.type || "").trim();
  if (!name) throw new Error("connector name is required");
  if (!type) throw new Error("connector type is required");
  const config = input.config || {};
  assertConnectorConfigSafe(config);
  const endpoint = validateConnectorEndpoint(input.endpoint);
  const secretRef = validateConnectorSecretRef(input.secret_ref);
  const connectorId = input.connector_id || newId("connector");
  const ts = nowIso();
  dbStore.getDb().prepare(`
    INSERT INTO platform_connectors
      (connector_id, name, type, state, endpoint, secret_ref, capabilities_json, config_json, registered_at, updated_at, metadata_json)
    VALUES (?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?, ?)
  `).run(connectorId, name, type, endpoint, secretRef, json(input.capabilities || []), json(config), ts, ts, json(input.metadata || {}));
  const connector = getConnector(connectorId);
  appendEvent({ event_type: "connector.registered", source: input.source || "platform", subject_type: "connector", subject_id: connectorId, payload: { name, type, secret_ref: secretRef ? "present" : null }, correlation_id: connectorId });
  return connector;
}

function getConnector(connectorId) {
  ensurePlatformKernelSchema();
  return normalizeConnector(dbStore.getDb().prepare("SELECT * FROM platform_connectors WHERE connector_id = ?").get(String(connectorId)));
}

function listConnectors({ state, type, limit = 50 } = {}) {
  ensurePlatformKernelSchema();
  const conditions = [];
  const params = [];
  if (state) { if (!CONNECTOR_STATES.includes(state)) throw new Error(`Invalid connector state: ${state}`); conditions.push("state = ?"); params.push(state); }
  if (type) { conditions.push("type = ?"); params.push(String(type)); }
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  return dbStore.getDb().prepare(`SELECT * FROM platform_connectors ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params, boundedLimit).map(normalizeConnector);
}

function listConnectorEvents(connectorId, limit = 20) {
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

function transitionConnector(connectorId, nextState, details = {}) {
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
  const projectId = String(input.project_id || "").trim();
  const createdBy = String(input.created_by || "").trim();
  if (!projectId) throw new Error("scope snapshot project_id is required");
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
  if (project_id) { conditions.push("project_id = ?"); params.push(String(project_id)); }
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
  else if (project_id && String(project_id) !== snapshot.project_id) reason = "project_mismatch";
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

function registerArtifact(input = {}) {
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
    const parent = dbStore.getDb().prepare("SELECT artifact_id, deleted_at FROM platform_artifacts WHERE artifact_id = ?").get(input.supersedes_artifact_id);
    if (!parent) throw new Error(`Parent artifact not found: ${input.supersedes_artifact_id}`);
    if (parent.deleted_at) throw new Error("derivatives cannot be created from deleted artifacts");
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
      schema_version, lineage_json, verification_json, supersedes_artifact_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
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
    json(input.metadata || {})
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

function getArtifact(artifactId) {
  ensurePlatformKernelSchema();
  return normalizeArtifact(dbStore.getDb().prepare("SELECT * FROM platform_artifacts WHERE artifact_id = ?").get(String(artifactId)));
}

function listArtifacts(query = {}) {
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

function findActiveExecution(query = {}) {
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

function platformGuard(executionId, expectedState, options = {}) {
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

function grantCapability(input = {}) {
  ensurePlatformKernelSchema();
  const capId = input.capability_id || newId("cap");
  const ts = input.granted_at || nowIso();
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO platform_capabilities (capability_id, actor_id, capability, project_id, granted_by, granted_at, expires_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(capId, input.actor_id, input.capability, input.project_id || null, input.granted_by || null, ts, input.expires_at || null, json(input.metadata || {}));
  appendEvent({
    event_type: "capability.granted",
    source: input.source || "platform",
    actor_id: input.granted_by || "system",
    subject_type: "capability",
    subject_id: capId,
    project_id: input.project_id,
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
  const conditions = ["actor_id = ?", "capability = ?", "revoked_at IS NULL"];
  const params = [actorId, capability];
  if (projectId) { conditions.push("(project_id = ? OR project_id IS NULL)"); params.push(projectId); }
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
    INSERT INTO platform_workflows (workflow_id, name, description, state, current_step, total_steps, execution_id, project_id, created_by, created_at, updated_at, checkpoint_json, metadata_json)
    VALUES (?, ?, ?, 'defined', 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workflowId, input.name || "unnamed", input.description || null, steps.length, input.execution_id || null, input.project_id || null, input.created_by || null, ts, ts, json(input.checkpoint || {}), json(input.metadata || {}));
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
  if (success) {
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
    INSERT INTO platform_runner_sessions (runner_id, execution_id, workflow_id, state, resource_limits_json, started_at, metadata_json)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `).run(runnerId, input.execution_id || null, input.workflow_id || null, json(input.resource_limits || {}), ts, json(input.metadata || {}));
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
  const ts = nowIso();
  const wsId = newId("ws");
  dbStore.getDb().transaction(() => {
    dbStore.getDb().prepare("INSERT INTO platform_project_workspaces (workspace_id, name, project_id, owner_id, state, config_json, secrets_json, environment, resource_limits_json, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, 'active', ?, '{}', ?, ?, ?, ?, ?)").run(wsId, input.name || input.project_id, input.project_id, input.owner_id || "system", json(input.config), input.environment || "default", json(input.resource_limits), ts, ts, json(input.metadata));
    appendEvent({ event_type: "workspace.created", source: input.source || "platform", actor_id: input.owner_id, subject_type: "workspace", subject_id: wsId, project_id: input.project_id, payload: { name: input.name || input.project_id }, correlation_id: wsId });
    for (const [name, stored] of secretEntries) {
      setWorkspaceSecret(wsId, name, stored, { source: input.source, actor_id: input.owner_id });
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
  const row = dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE project_id = ? AND state = 'active'").get(projectId);
  return normalizeWorkspace(row, row ? getWorkspaceSecretNames(row.workspace_id) : []);
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
  const projectId = normalizeProjectId(input.project_id);
  const ts = nowIso();
  const result = dbStore.getDb().prepare("INSERT OR IGNORE INTO platform_projects (project_id, display_name, description, owner_actor_id, state, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)").run(projectId, input.display_name || projectId, input.description || null, input.owner_actor_id || null, ts, ts, json(input.metadata));
  if (result.changes > 0) {
    appendEvent({ event_type: "project.registered", source: input.source || "platform", actor_id: input.owner_actor_id || null, subject_type: "project", subject_id: projectId, payload: { display_name: input.display_name || projectId }, correlation_id: projectId });
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
  for (const scan of scans) {
    let rows;
    try {
      rows = dbStore.getDb().prepare(`SELECT ${scan.projectCol} AS project_id, COUNT(*) AS cnt FROM ${scan.table} WHERE ${scan.projectCol} IS NOT NULL AND ${scan.projectCol} != '' GROUP BY ${scan.projectCol}`).all();
    } catch {
      continue;
    }
    perSource[scan.source] = rows.length;
    for (const row of rows) {
      const pid = String(row.project_id).trim();
      if (!pid) continue;
      registerProject({ project_id: pid });
      upsert.run(pid, scan.source, ts, ts, row.cnt, json({ backfilled_at: ts }));
      written++;
    }
  }
  appendEvent({ event_type: "project.sources_backfilled", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "project", subject_id: "*", payload: { written, per_source: perSource }, correlation_id: details.correlation_id || null });
  return { written, sources: perSource };
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
    const cleared = clear.run(ts, row.workspace_id, row.secrets_json);
    if (cleared.changes === 0) {
      retained.push(row.workspace_id);
      continue;
    }
    workspacesMigrated++;
  }
  appendEvent({ event_type: "workspace.secrets_backfilled", source: details.source || "platform", actor_id: details.actor_id || null, subject_type: "workspace", subject_id: "*", payload: { workspaces_migrated: workspacesMigrated, secrets_migrated: migrated, secrets_skipped_existing: skippedExisting, secrets_skipped_null: skippedNull, workspaces_unreadable: unreadable.length, workspaces_retained: retained.length }, correlation_id: details.correlation_id || null });
  return { workspaces_scanned: rows.length, workspaces_migrated: workspacesMigrated, secrets_migrated: migrated, secrets_skipped_existing: skippedExisting, secrets_skipped_null: skippedNull, workspaces_unreadable: unreadable, workspaces_retained: retained };
}

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
    try { rowCounts[table] = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get().cnt; } catch { rowCounts[table] = 0; }
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
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_backups SET state = 'completed', completed_at = ?, file_path = ?, file_size_bytes = ?, checksum = ? WHERE backup_id = ?").run(ts, details.file_path || null, details.file_size_bytes || null, details.checksum || null, backupId);
  appendEvent({ event_type: "backup.completed", source: details.source || "platform", actor_id: details.actor_id, subject_type: "backup", subject_id: backupId, payload: { file_path: details.file_path, file_size_bytes: details.file_size_bytes }, correlation_id: backupId });
  return dbStore.getDb().prepare("SELECT * FROM platform_backups WHERE backup_id = ?").get(backupId);
}

function restoreBackup(backupId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_backups SET state = 'restored', restored_at = ? WHERE backup_id = ?").run(ts, backupId);
  appendEvent({ event_type: "backup.restored", source: details.source || "platform", actor_id: details.actor_id, subject_type: "backup", subject_id: backupId, payload: { restored_from: backupId }, correlation_id: backupId });
  return dbStore.getDb().prepare("SELECT * FROM platform_backups WHERE backup_id = ?").get(backupId);
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
