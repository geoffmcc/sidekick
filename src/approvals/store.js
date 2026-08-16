"use strict";

/**
 * Storage layer for approval continuation
 * (docs/adr-approval-continuation.md §4).
 *
 * Owns the runtime `ensure` counterpart to migration 025 — several subsystems
 * create schema outside migrations for tests (`platform/kernel.js`,
 * `compute/job-manager.js`), so a table that only exists in a migration is
 * invisible to those paths. The DDL here is kept byte-equivalent in effect to
 * `migrations/025_approval_continuation.sql`; the migration remains the
 * authority for a real deployment.
 *
 * This module deliberately does NOT require `src/tools-legacy.js`. The
 * transactions in `continuation.js` run inside the dispatcher's call path, and
 * a top-level require of legacy would close the cycle the tool architecture
 * (docs/tool-architecture.md) exists to prevent.
 */

const crypto = require("crypto");
const dbStore = require("../db");
const { encryptColumn, decryptColumn, hasSecretKey } = require("../core/secret-cipher");
const { argsDigest } = require("./keys");
const vocabulary = require("./vocabulary");
const { LIVE_APPROVAL_STATUSES, REASON_CODES } = vocabulary;

const LIVE_STATUS_SQL = LIVE_APPROVAL_STATUSES.map(s => `'${s}'`).join(", ");

function getDb() {
  return dbStore.getDb();
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

const newApprovalId = () => newId("approval");
const newOperationId = () => "op_" + Date.now().toString(36) + "_" + crypto.randomBytes(8).toString("hex");
const newExecutorId = () => `${process.pid || "pid"}_${crypto.randomBytes(6).toString("hex")}`;
const newRecoveryEventId = () => newId("aere");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getApprovalTtlSeconds() {
  const configured = parseInt(process.env.SIDEKICK_APPROVAL_TTL_SECONDS || "3600", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 3600;
}

function getCheckpointLeaseSeconds() {
  const configured = parseInt(process.env.SIDEKICK_CHECKPOINT_LEASE_SECONDS || process.env.SIDEKICK_APPROVAL_LEASE_SECONDS || "300", 10);
  if (!Number.isFinite(configured)) return 300;
  return Math.min(Math.max(configured, 30), 3600);
}

/**
 * Bounds pathological looping independently of the checkpoint's own counter
 * (§5/T3): an action reclaimed beyond this many attempts is failed rather than
 * reclaimed again.
 */
function getMaxActionAttempts() {
  const configured = parseInt(process.env.SIDEKICK_APPROVAL_MAX_ATTEMPTS || "5", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

function leaseExpiresAt(fromMs = Date.now()) {
  return new Date(fromMs + getCheckpointLeaseSeconds() * 1000).toISOString();
}

function expiresAtFrom(fromMs = Date.now()) {
  return new Date(fromMs + getApprovalTtlSeconds() * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Runtime schema ensure
// ---------------------------------------------------------------------------

let ensured = false;

function ensureApprovalContinuationSchema(force = false) {
  if (ensured && !force) return;
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_checkpoints (
      task_id             TEXT PRIMARY KEY,
      root_task_id        TEXT,
      state               TEXT NOT NULL,
      goal_encrypted      TEXT,
      classification_json TEXT NOT NULL DEFAULT '{}',
      plan_version        TEXT NOT NULL,
      plan_encrypted      TEXT,
      plan_digest         TEXT NOT NULL,
      next_step_id        TEXT,
      current_approval_id     TEXT,
      current_step_id         TEXT,
      current_args_digest     TEXT,
      current_idempotency_key TEXT,
      progress_encrypted  TEXT,
      evidence_encrypted  TEXT,
      evidence_chars      INTEGER NOT NULL DEFAULT 0,
      successful_tool_evidence INTEGER NOT NULL DEFAULT 0,
      claimed_by          TEXT,
      lease_expires_at    TEXT,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      claim_epoch         INTEGER NOT NULL DEFAULT 0,
      prior_operation_id  TEXT,
      prior_claimed_by    TEXT,
      prior_claim_epoch   INTEGER,
      prior_attempt_count INTEGER,
      deadline_at         TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      platform_execution_id TEXT,
      root_execution_id     TEXT,
      schema_version        INTEGER NOT NULL DEFAULT 1,
      CHECK (
        state = 'archived'
        OR (goal_encrypted IS NOT NULL AND plan_encrypted IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_task_checkpoints_runnable
      ON task_checkpoints(state, lease_expires_at)
      WHERE state IN ('runnable', 'running');

    CREATE INDEX IF NOT EXISTS idx_task_checkpoints_parked
      ON task_checkpoints(state, updated_at)
      WHERE state IN ('waiting_for_approval', 'reconciling');

    CREATE TABLE IF NOT EXISTS approvals (
      approval_id           TEXT PRIMARY KEY,
      status                TEXT NOT NULL,
      tool_name             TEXT NOT NULL,
      risk                  TEXT NOT NULL DEFAULT 'unknown',
      source                TEXT NOT NULL,
      mode                  TEXT,
      reason_encrypted      TEXT,
      task_id               TEXT,
      step_id               TEXT,
      plan_version          TEXT,
      args_digest           TEXT NOT NULL,
      idempotency_key       TEXT NOT NULL,
      args_encrypted        TEXT,
      requester_identity    TEXT,
      requested_by_principal_id TEXT,
      actor_principal_id    TEXT,
      acting_for_principal_id TEXT,
      approver_identity     TEXT,
      approved_by_principal_id TEXT,
      executed_by_principal_id TEXT,
      requires_human_approval INTEGER NOT NULL DEFAULT 0,
      approval_policy       TEXT,
      terminalized_by       TEXT,
      terminalized_at       TEXT,
      reconciled_by         TEXT,
      reconciled_at         TEXT,
      reconciliation_decision TEXT,
      requested_at          TEXT NOT NULL,
      expires_at            TEXT NOT NULL,
      decided_at            TEXT,
      completed_at          TEXT,
      updated_at            TEXT NOT NULL,
      operation_id          TEXT,
      executor_id           TEXT,
      lease_expires_at      TEXT,
      attempt_count         INTEGER NOT NULL DEFAULT 0,
      reconciliation_status TEXT NOT NULL DEFAULT 'not_required',
      result_digest         TEXT,
      error_code            TEXT,
      error_detail_encrypted TEXT,
      platform_execution_id TEXT,
      timeout_ms            INTEGER,
      schema_version        INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (task_id) REFERENCES task_checkpoints(task_id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_idempotency
      ON approvals(idempotency_key);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_live_action
      ON approvals(task_id, step_id, plan_version, tool_name, args_digest)
      WHERE status IN (${LIVE_STATUS_SQL});

    CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_one_live_per_task
      ON approvals(task_id)
      WHERE task_id IS NOT NULL
        AND status IN (${LIVE_STATUS_SQL});

    CREATE INDEX IF NOT EXISTS idx_approvals_status_expiry ON approvals(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_task          ON approvals(task_id);

    CREATE TABLE IF NOT EXISTS task_step_results (
      task_id         TEXT NOT NULL,
      step_id         TEXT NOT NULL,
      plan_version    TEXT NOT NULL,
      args_digest     TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status          TEXT NOT NULL,
      result_encrypted TEXT,
      result_digest   TEXT,
      outcome_code    TEXT,
      error_detail_encrypted TEXT,
      approval_id     TEXT,
      recorded_at     TEXT NOT NULL,
      PRIMARY KEY (task_id, step_id, plan_version)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_step_results_idempotency
      ON task_step_results(idempotency_key);

    CREATE TABLE IF NOT EXISTS approval_execution_recovery_events (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      operation_id TEXT,
      executor_id TEXT,
      event_type TEXT NOT NULL,
      reconciliation_status TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_runtime_meta (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Additive columns from migration 025. Applied here too so a test database
  // built purely from `ensure` carries them.
  const recoveryColumns = new Set(db.prepare("PRAGMA table_info(approval_execution_recovery_events)").all().map(c => c.name));
  const additions = [
    ["reason_code", "TEXT"],
    ["reason_detail_encrypted", "TEXT"],
    ["recovery_executor_id", "TEXT"],
    ["prior_claim_epoch", "INTEGER"],
    ["prior_attempt_count", "INTEGER"],
  ];
  for (const [column, type] of additions) {
    if (recoveryColumns.has(column)) continue;
    try {
      db.exec(`ALTER TABLE approval_execution_recovery_events ADD COLUMN ${column} ${type}`);
    } catch (error) {
      // The `PRAGMA table_info` read and the ALTER are not atomic, so two
      // processes starting together can both see the column as missing and
      // both try to add it. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the
      // loser throws — and in src/index.js that is fatal, which would take
      // sidekick-mcp down on startup for a column that now exists. Swallowing
      // exactly this error is what actually closes the race that moving the
      // ALTERs out of migration 025 was meant to close; the check-then-act
      // above only narrowed it.
      if (!/duplicate column name/i.test(String(error && error.message || ""))) throw error;
    }
  }
  const approvalColumns = new Set(db.prepare("PRAGMA table_info(approvals)").all().map(c => c.name));
  const approvalAdditions = [
    ["requested_by_principal_id", "TEXT"],
    ["actor_principal_id", "TEXT"],
    ["acting_for_principal_id", "TEXT"],
    ["approved_by_principal_id", "TEXT"],
    ["executed_by_principal_id", "TEXT"],
    ["requires_human_approval", "INTEGER NOT NULL DEFAULT 0"],
    ["approval_policy", "TEXT"],
  ];
  for (const [column, type] of approvalAdditions) {
    if (approvalColumns.has(column)) continue;
    try { db.exec(`ALTER TABLE approvals ADD COLUMN ${column} ${type}`); }
    catch (error) { if (!/duplicate column name/i.test(String(error && error.message || ""))) throw error; }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_approvals_requested_principal ON approvals(requested_by_principal_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_approvals_actor_principal ON approvals(actor_principal_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_approvals_approved_principal ON approvals(approved_by_principal_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_approval_recovery_reason_code ON approval_execution_recovery_events(reason_code)");

  ensured = true;
}

function resetEnsuredForTests() {
  ensured = false;
}

// ---------------------------------------------------------------------------
// Payload encryption (§4.4)
// ---------------------------------------------------------------------------

/**
 * Encrypt a JSON-serializable payload. Digests are computed over PLAINTEXT
 * before encryption by the caller and stored in the clear, so integrity and
 * identity stay queryable without exposing content.
 */
function encryptJson(value) {
  if (value === undefined) return null;
  return encryptColumn(JSON.stringify(value));
}

function decryptJson(column) {
  const plaintext = decryptColumn(column);
  if (plaintext == null) return null;
  return JSON.parse(plaintext);
}

/**
 * Constructed detail for an error/outcome column. NEVER pass a captured
 * exception message here — §4.4 forbids widening these columns into a place
 * where `e.message` can land. Callers assemble the string from known-safe
 * components (codes, ids, digests).
 */
function encryptDetail(detail) {
  if (detail == null) return null;
  return encryptColumn(String(detail));
}

// ---------------------------------------------------------------------------
// Row access
// ---------------------------------------------------------------------------

function getApproval(approvalId) {
  return getDb().prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) || null;
}

function getApprovalByIdempotencyKey(key) {
  return getDb().prepare("SELECT * FROM approvals WHERE idempotency_key = ?").get(key) || null;
}

function getCheckpoint(taskId) {
  return getDb().prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId) || null;
}

function getStepResult(taskId, stepId, planVersion) {
  return getDb().prepare(
    "SELECT * FROM task_step_results WHERE task_id = ? AND step_id = ? AND plan_version = ?"
  ).get(taskId, stepId, planVersion) || null;
}

function listApprovalRows({ status, taskId, limit = 100 } = {}) {
  const max = Math.min(parseInt(limit, 10) || 100, 500);
  const clauses = [];
  const params = [];
  if (status) { clauses.push("status = ?"); params.push(status); }
  if (taskId) { clauses.push("task_id = ?"); params.push(taskId); }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  params.push(max);
  return getDb().prepare(`SELECT * FROM approvals ${where} ORDER BY requested_at DESC LIMIT ?`).all(...params);
}

/**
 * Approvals whose authorization window has lapsed. `retry_authorized` is
 * included because T10 refreshes `expires_at` when it grants a retry, and that
 * fresh window is meaningless unless something enforces it (§7.2, I24).
 */
function listExpiredApprovals(now = nowIso()) {
  return getDb().prepare(
    "SELECT * FROM approvals WHERE status IN ('pending','retry_authorized') AND expires_at < ? ORDER BY expires_at ASC LIMIT 200"
  ).all(now);
}

function listParkedCheckpoints() {
  return getDb().prepare(
    "SELECT * FROM task_checkpoints WHERE state IN ('waiting_for_approval','runnable') ORDER BY updated_at ASC LIMIT 200"
  ).all();
}

function listClaimableCheckpoints(now = nowIso()) {
  return getDb().prepare(`
    SELECT * FROM task_checkpoints
     WHERE state = 'runnable'
        OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
     ORDER BY updated_at ASC LIMIT 200
  `).all(now);
}

function listOverdueCheckpoints(now = nowIso()) {
  return getDb().prepare(`
    SELECT * FROM task_checkpoints
     WHERE deadline_at IS NOT NULL AND deadline_at < ?
       AND state IN ('waiting_for_approval','runnable','running','reconciling')
     ORDER BY deadline_at ASC LIMIT 200
  `).all(now);
}

// ---------------------------------------------------------------------------
// Task-runner liveness heartbeat
// ---------------------------------------------------------------------------

/**
 * The resume scheduler writes this every poll; `executeApprovedTool` (T2)
 * reads it before promising that "the task will be resumed by the task
 * runner". Lives in the approvals store because this store owns the
 * checkpoint schema the promise is about — a runnable checkpoint and the
 * heartbeat that proves something will claim it belong to the same authority.
 *
 * The freshness window derives from the WRITER's declared poll interval (kept
 * inside the value), so the reader — usually a different process — never has
 * to guess the runner's configuration from its own environment.
 */
const TASK_RUNNER_HEARTBEAT_KEY = "task_runner_heartbeat";

function writeTaskRunnerHeartbeat({ runner, intervalMs } = {}) {
  ensureApprovalContinuationSchema();
  getDb().prepare(`
    INSERT INTO approval_runtime_meta (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(TASK_RUNNER_HEARTBEAT_KEY, JSON.stringify({ runner: runner || null, interval_ms: Number(intervalMs) || null }), nowIso());
}

function getTaskRunnerHeartbeat() {
  ensureApprovalContinuationSchema();
  const row = getDb().prepare("SELECT value_json, updated_at FROM approval_runtime_meta WHERE key = ?").get(TASK_RUNNER_HEARTBEAT_KEY);
  if (!row) return null;
  let value = {};
  try { value = JSON.parse(row.value_json) || {}; } catch { value = {}; }
  return { runner: value.runner || null, intervalMs: Number(value.interval_ms) || null, updatedAt: row.updated_at };
}

/**
 * Freshness check, fail-closed: no heartbeat, an unparseable timestamp, or one
 * older than three declared poll intervals (min 30s, so a slow poller isn't
 * declared dead by clock jitter) all report the runner as not live.
 */
function isTaskRunnerLive(now = Date.now()) {
  let heartbeat;
  try {
    heartbeat = getTaskRunnerHeartbeat();
  } catch {
    return { live: false, reason: "heartbeat_unreadable" };
  }
  if (!heartbeat || !heartbeat.updatedAt) return { live: false, reason: "no_heartbeat" };
  const at = Date.parse(heartbeat.updatedAt);
  if (!Number.isFinite(at)) return { live: false, reason: "heartbeat_invalid" };
  const windowMs = Math.max(3 * (heartbeat.intervalMs || 5000), 30000);
  const ageMs = now - at;
  if (ageMs > windowMs) return { live: false, reason: "stale_heartbeat", ageMs, windowMs };
  return { live: true, ageMs, windowMs, runner: heartbeat.runner };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Write an `approval_execution_recovery_events` row using the closed-vocabulary
 * `reason_code` column. The legacy free-form `reason` column is retained for
 * existing rows and is deliberately never written here (§4.4).
 *
 * Unlike the legacy writer (`tools-legacy.js`, which swallowed every error),
 * this throws. These events are the audit trail for exactly the situations
 * where silence is most damaging, and every caller runs inside a transaction
 * that should roll back if the audit cannot be recorded.
 */
function recordRecoveryEvent({
  approvalId,
  eventType,
  reconciliationStatus = null,
  reasonCode = null,
  reasonDetail = null,
  operationId = null,
  executorId = null,
  recoveryExecutorId = null,
  priorClaimEpoch = null,
  priorAttemptCount = null,
  at = nowIso(),
}) {
  // All three operator-facing text columns are closed vocabularies, not just
  // `reason_code`. Validating one of three left `event_type` and
  // `reconciliation_status` as free-form TEXT — exactly where an `e.message`
  // drifts in once someone passes a caught error through.
  if (reasonCode != null && !REASON_CODES.includes(reasonCode)) {
    throw new Error(`Invalid reason_code: ${String(reasonCode).slice(0, 40)}`);
  }
  vocabulary.assertRecoveryEventType(eventType);
  if (reconciliationStatus != null) vocabulary.assertReconciliationStatus(reconciliationStatus);
  getDb().prepare(`
    INSERT INTO approval_execution_recovery_events (
      id, approval_id, operation_id, executor_id, recovery_executor_id,
      prior_claim_epoch, prior_attempt_count, event_type,
      reconciliation_status, reason_code, reason_detail_encrypted, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newRecoveryEventId(),
    approvalId,
    operationId,
    executorId,
    recoveryExecutorId,
    priorClaimEpoch,
    priorAttemptCount,
    eventType,
    reconciliationStatus,
    reasonCode,
    reasonDetail == null ? null : encryptDetail(reasonDetail),
    at
  );
}

module.exports = {
  getDb,
  nowIso,
  newId,
  newApprovalId,
  newOperationId,
  newExecutorId,
  getApprovalTtlSeconds,
  getCheckpointLeaseSeconds,
  getMaxActionAttempts,
  leaseExpiresAt,
  expiresAtFrom,
  ensureApprovalContinuationSchema,
  resetEnsuredForTests,
  encryptJson,
  decryptJson,
  encryptDetail,
  hasSecretKey,
  argsDigest,
  getApproval,
  getApprovalByIdempotencyKey,
  getCheckpoint,
  getStepResult,
  listApprovalRows,
  listExpiredApprovals,
  listParkedCheckpoints,
  listClaimableCheckpoints,
  listOverdueCheckpoints,
  recordRecoveryEvent,
  writeTaskRunnerHeartbeat,
  getTaskRunnerHeartbeat,
  isTaskRunnerLive,
  LIVE_STATUS_SQL,
};
