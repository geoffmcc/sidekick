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

    CREATE TABLE IF NOT EXISTS platform_capabilities (
      capability_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      project_id TEXT,
      granted_by TEXT,
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_capabilities_actor ON platform_capabilities(actor_id, capability, project_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_platform_capabilities_actor_scan ON platform_capabilities(actor_id, revoked_at);

    CREATE TABLE IF NOT EXISTS platform_change_sets (
      change_set_id TEXT PRIMARY KEY,
      execution_id TEXT,
      approval_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_action TEXT,
      operation_type TEXT NOT NULL,
      state TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      previous_hash TEXT,
      actor_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      args_snapshot_json TEXT NOT NULL DEFAULT '{}',
      result_summary TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_platform_change_sets_approval ON platform_change_sets(approval_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_platform_change_sets_execution ON platform_change_sets(execution_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_platform_change_sets_hash ON platform_change_sets(content_hash);

    CREATE TABLE IF NOT EXISTS platform_workflows (
      workflow_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      state TEXT NOT NULL DEFAULT 'defined',
      current_step INTEGER NOT NULL DEFAULT 0,
      total_steps INTEGER NOT NULL DEFAULT 0,
      execution_id TEXT,
      project_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      failed_at TEXT,
      checkpoint_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_platform_workflows_state ON platform_workflows(state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_platform_workflows_project ON platform_workflows(project_id, state);

    CREATE TABLE IF NOT EXISTS platform_workflow_steps (
      step_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      tool_name TEXT,
      tool_action TEXT,
      args_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      result_summary TEXT,
      error_category TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 0,
      execution_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_workflow_steps_idx ON platform_workflow_steps(workflow_id, step_index);
    CREATE INDEX IF NOT EXISTS idx_platform_workflow_steps_state ON platform_workflow_steps(state, workflow_id);

    CREATE TABLE IF NOT EXISTS platform_runner_sessions (
      runner_id TEXT PRIMARY KEY,
      execution_id TEXT,
      workflow_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      resource_limits_json TEXT NOT NULL DEFAULT '{}',
      resource_usage_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      heartbeat_at TEXT,
      completed_at TEXT,
      terminated_reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_platform_runner_sessions_state ON platform_runner_sessions(state, started_at DESC);

    CREATE TABLE IF NOT EXISTS platform_project_workspaces (
      workspace_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      config_json TEXT NOT NULL DEFAULT '{}',
      secrets_json TEXT NOT NULL DEFAULT '{}',
      environment TEXT,
      resource_limits_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_workspaces_project ON platform_project_workspaces(project_id) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_platform_workspaces_owner ON platform_project_workspaces(owner_id, state);
    CREATE INDEX IF NOT EXISTS idx_platform_workspaces_state ON platform_project_workspaces(state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS platform_model_registry (
      model_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      version TEXT,
      state TEXT NOT NULL DEFAULT 'registered',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      context_window INTEGER,
      max_output_tokens INTEGER,
      supports_streaming INTEGER NOT NULL DEFAULT 0,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      supports_tools INTEGER NOT NULL DEFAULT 1,
      cost_per_1k_input REAL,
      cost_per_1k_output REAL,
      rate_limit_rpm INTEGER,
      registered_by TEXT,
      registered_at TEXT NOT NULL,
      deprecated_at TEXT,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_model_name_provider ON platform_model_registry(name, provider);
    CREATE INDEX IF NOT EXISTS idx_platform_model_state ON platform_model_registry(state, registered_at DESC);

    CREATE TABLE IF NOT EXISTS platform_extensions (
      extension_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'registered',
      type TEXT NOT NULL DEFAULT 'plugin',
      author TEXT,
      description TEXT,
      entry_point TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      config_schema_json TEXT NOT NULL DEFAULT '{}',
      config_json TEXT NOT NULL DEFAULT '{}',
      hooks_json TEXT NOT NULL DEFAULT '[]',
      registered_at TEXT NOT NULL,
      activated_at TEXT,
      deactivated_at TEXT,
      uninstalled_at TEXT,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_extension_name ON platform_extensions(name);
    CREATE INDEX IF NOT EXISTS idx_platform_extension_state ON platform_extensions(state, registered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_platform_extension_type ON platform_extensions(type, state);
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

function createProjectWorkspace(input = {}) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  const wsId = newId("ws");
  dbStore.getDb().prepare("INSERT INTO platform_project_workspaces (workspace_id, name, project_id, owner_id, state, config_json, secrets_json, environment, resource_limits_json, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)").run(wsId, input.name || input.project_id, input.project_id, input.owner_id || "system", json(input.config), json(input.secrets), input.environment || "default", json(input.resource_limits), ts, ts, json(input.metadata));
  appendEvent({ event_type: "workspace.created", source: input.source || "platform", actor_id: input.owner_id, subject_type: "workspace", subject_id: wsId, project_id: input.project_id, payload: { name: input.name || input.project_id }, correlation_id: wsId });
  return dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE workspace_id = ?").get(wsId);
}

function getProjectWorkspace(workspaceId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
  if (!row) return null;
  return { ...row, config: parseJson(row.config_json, {}), secrets: parseJson(row.secrets_json, {}), resource_limits: parseJson(row.resource_limits_json, {}), metadata: parseJson(row.metadata_json, {}) };
}

function getWorkspaceByProject(projectId) {
  ensurePlatformKernelSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE project_id = ? AND state = 'active'").get(projectId);
  if (!row) return null;
  return { ...row, config: parseJson(row.config_json, {}), secrets: parseJson(row.secrets_json, {}), resource_limits: parseJson(row.resource_limits_json, {}), metadata: parseJson(row.metadata_json, {}) };
}

function updateProjectWorkspace(workspaceId, updates = {}) {
  ensurePlatformKernelSchema();
  const ts = nowIso();
  const existing = dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
  if (!existing) throw new Error(`Workspace ${workspaceId} not found`);
  const config = updates.config !== undefined ? json(updates.config) : existing.config_json;
  const secrets = updates.secrets !== undefined ? json(updates.secrets) : existing.secrets_json;
  const environment = updates.environment || existing.environment;
  const resourceLimits = updates.resource_limits !== undefined ? json(updates.resource_limits) : existing.resource_limits_json;
  const metadata = updates.metadata !== undefined ? json(updates.metadata) : existing.metadata_json;
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET config_json = ?, secrets_json = ?, environment = ?, resource_limits_json = ?, metadata_json = ?, updated_at = ? WHERE workspace_id = ?").run(config, secrets, environment, resourceLimits, metadata, ts, workspaceId);
  appendEvent({ event_type: "workspace.updated", source: updates.source || "platform", actor_id: updates.actor_id, subject_type: "workspace", subject_id: workspaceId, payload: { updated_fields: Object.keys(updates) }, correlation_id: workspaceId });
  return dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
}

function archiveProjectWorkspace(workspaceId, details = {}) {
  ensurePlatformKernelSchema();
  const ts = details.timestamp || nowIso();
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET state = 'archived', archived_at = ?, updated_at = ? WHERE workspace_id = ?").run(ts, ts, workspaceId);
  appendEvent({ event_type: "workspace.archived", source: details.source || "platform", actor_id: details.actor_id, subject_type: "workspace", subject_id: workspaceId, payload: {}, correlation_id: workspaceId });
  return dbStore.getDb().prepare("SELECT * FROM platform_project_workspaces WHERE workspace_id = ?").get(workspaceId);
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
  const recentEvents = db.prepare("SELECT event_type, COUNT(*) as cnt FROM platform_execution_events WHERE timestamp > datetime('now', '-24h') GROUP BY event_type ORDER BY cnt DESC LIMIT 10").all();
  const activeModels = db.prepare("SELECT name, provider, usage_count FROM platform_model_registry WHERE state = 'registered' ORDER BY usage_count DESC LIMIT 5").all();
  const activeExtensions = db.prepare("SELECT name, type, state, usage_count FROM platform_extensions WHERE state = 'active' ORDER BY usage_count DESC LIMIT 5").all();
  return {
    generated_at: nowIso(),
    summary: { executions: execCount, events: eventCount, artifacts: artifactCount, workflows: workflowCount, runners: runnerCount, workspaces: workspaceCount, models: modelCount, extensions: extensionCount, capabilities: capabilityCount, change_sets: changeSetCount },
    execution_states: states,
    recent_events_24h: recentEvents,
    active_models: activeModels,
    active_extensions: activeExtensions,
    tables: ["platform_executions", "platform_execution_events", "platform_artifacts", "platform_execution_transitions", "platform_capabilities", "platform_change_sets", "platform_workflows", "platform_workflow_steps", "platform_runner_sessions", "platform_project_workspaces", "platform_model_registry", "platform_extensions"],
  };
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
  registerArtifact,
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
  createProjectWorkspace,
  getProjectWorkspace,
  getWorkspaceByProject,
  updateProjectWorkspace,
  archiveProjectWorkspace,
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
};
