const crypto = require("crypto");
const path = require("path");
const dbStore = require("../db");
const { redactSensitive } = require("../redact");

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
  awaiting_approval: ["ready", "blocked", "cancelled", "timed_out", "failed"],
  ready: ["running", "blocked", "cancelled", "timed_out", "failed"],
  running: ["waiting", "retrying", "verifying", "completed", "partial", "failed", "cancelled", "timed_out", "rolling_back", "orphaned"],
  waiting: ["running", "blocked", "cancelled", "timed_out", "orphaned"],
  blocked: ["planned", "queued", "ready", "cancelled", "failed"],
  retrying: ["queued", "running", "failed", "cancelled", "timed_out"],
  verifying: ["completed", "partial", "failed", "rolling_back", "rollback_failed"],
  rolling_back: ["rolled_back", "rollback_failed", "failed"],
  orphaned: ["queued", "running", "failed", "cancelled"],
});

function nowIso() {
  return new Date().toISOString();
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

function ensurePlatformKernelSchema() {
  const db = dbStore.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_executions (
      execution_id TEXT PRIMARY KEY,
      parent_execution_id TEXT,
      root_execution_id TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT,
      workflow_id TEXT,
      project_id TEXT,
      incident_id TEXT,
      change_set_id TEXT,
      actor_id TEXT,
      client_id TEXT,
      trigger_type TEXT,
      operation_type TEXT NOT NULL,
      tool_name TEXT,
      tool_action TEXT,
      resource_scope TEXT,
      environment TEXT,
      state TEXT NOT NULL,
      risk TEXT NOT NULL DEFAULT 'unknown',
      approval_state TEXT NOT NULL DEFAULT 'not_required',
      started_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      deadline_at TEXT,
      heartbeat_at TEXT,
      result_status TEXT,
      error_category TEXT,
      result_summary TEXT,
      artifact_count INTEGER NOT NULL DEFAULT 0,
      trace_id TEXT,
      span_id TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS platform_execution_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      actor_id TEXT,
      subject_type TEXT,
      subject_id TEXT,
      project_id TEXT,
      environment TEXT,
      execution_id TEXT,
      root_execution_id TEXT,
      task_id TEXT,
      session_id TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      payload_json TEXT NOT NULL DEFAULT '{}',
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      dedupe_key TEXT,
      causation_id TEXT,
      correlation_id TEXT,
      redaction_state TEXT NOT NULL DEFAULT 'redacted'
    );
    CREATE TABLE IF NOT EXISTS platform_artifacts (
      artifact_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      project_id TEXT,
      execution_id TEXT,
      task_id TEXT,
      session_id TEXT,
      producer TEXT,
      storage_ref TEXT NOT NULL,
      content_type TEXT,
      byte_size INTEGER,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      retention_class TEXT NOT NULL DEFAULT 'standard',
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      redaction_state TEXT NOT NULL DEFAULT 'unknown',
      schema_version INTEGER NOT NULL DEFAULT 1,
      lineage_json TEXT NOT NULL DEFAULT '{}',
      verification_json TEXT NOT NULL DEFAULT '{}',
      supersedes_artifact_id TEXT,
      deleted_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS platform_execution_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      previous_state TEXT,
      new_state TEXT NOT NULL,
      actor_id TEXT,
      reason TEXT,
      event_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_platform_executions_root ON platform_executions(root_execution_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_platform_events_execution ON platform_execution_events(execution_id, timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_events_dedupe ON platform_execution_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_platform_artifacts_execution ON platform_artifacts(execution_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_platform_transitions_execution ON platform_execution_transitions(execution_id, created_at);
  `);
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
  return db.prepare("SELECT * FROM platform_execution_events WHERE event_id = ?").get(eventId);
}

function registerArtifact(input = {}) {
  ensurePlatformKernelSchema();
  if (!input.storage_ref) throw new Error("storage_ref is required");
  const normalizedRef = path.posix.normalize(String(input.storage_ref).replace(/\\/g, "/"));
  if (normalizedRef.includes("../") || normalizedRef === ".." || path.isAbsolute(normalizedRef)) {
    throw new Error("storage_ref must be a safe relative path or opaque storage key");
  }
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
    json(input.lineage || {}),
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
  return dbStore.getDb().prepare("SELECT * FROM platform_artifacts WHERE artifact_id = ?").get(artifactId);
}

module.exports = {
  EXECUTION_STATES,
  ALLOWED_TRANSITIONS,
  ensurePlatformKernelSchema,
  validateTransition,
  createExecution,
  getExecution,
  transitionExecution,
  appendEvent,
  registerArtifact,
};
