const crypto = require("crypto");
const dbStore = require("../db");
const { JOB_STATES, JOB_TERMINAL_STATES, JOB_TRANSITIONS, JobError, LeaseExpiredError } = require("./errors");

function nowIso() { return new Date().toISOString(); }
function generateId(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`; }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function json(value) { return JSON.stringify(value || {}); }

function ensureSchema() {
  const db = dbStore.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_jobs (
      job_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      capability TEXT NOT NULL,
      source TEXT,
      project TEXT,
      task_id TEXT,
      session_id TEXT,
      root_execution_id TEXT,
      parent_execution_id TEXT,
      requesting_actor TEXT,
      data_classification TEXT NOT NULL DEFAULT 'private',
      capability_requirements_json TEXT NOT NULL DEFAULT '{}',
      routing_preferences_json TEXT NOT NULL DEFAULT '{}',
      request_payload_json TEXT NOT NULL DEFAULT '{}',
      selected_provider_id TEXT,
      selected_model_id TEXT,
      selected_worker_id TEXT,
      lease_id TEXT,
      lease_expires_at TEXT,
      lease_renewed_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'created',
      progress_percent INTEGER NOT NULL DEFAULT 0,
      progress_message TEXT,
      result_json TEXT,
      result_hash TEXT,
      error_category TEXT,
      error_message TEXT,
      fallback_history_json TEXT NOT NULL DEFAULT '[]',
      approval_required INTEGER NOT NULL DEFAULT 0,
      approval_state TEXT NOT NULL DEFAULT 'not_required',
      input_hash TEXT,
      timeout_ms INTEGER,
      started_at TEXT,
      queued_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_status ON compute_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_type ON compute_jobs(job_type);
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_worker ON compute_jobs(selected_worker_id);
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_project ON compute_jobs(project);
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_cap ON compute_jobs(capability);
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_lease ON compute_jobs(lease_id);

    CREATE TABLE IF NOT EXISTS compute_job_attempts (
      attempt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES compute_jobs(job_id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      worker_id TEXT,
      lease_id TEXT,
      status TEXT NOT NULL DEFAULT 'starting',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      duration_ms INTEGER,
      result_json TEXT,
      result_hash TEXT,
      error_category TEXT,
      error_message TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      first_token_latency_ms INTEGER,
      total_latency_ms INTEGER,
      accelerator TEXT,
      model_load_time_ms INTEGER,
      fallback_reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compute_attempts_job ON compute_job_attempts(job_id);
    CREATE INDEX IF NOT EXISTS idx_compute_attempts_status ON compute_job_attempts(status);

    CREATE TABLE IF NOT EXISTS compute_artifacts (
      artifact_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES compute_jobs(job_id) ON DELETE CASCADE,
      attempt_id TEXT,
      artifact_type TEXT NOT NULL,
      name TEXT NOT NULL,
      storage_path TEXT,
      storage_ref TEXT,
      content_type TEXT,
      content_hash TEXT,
      size_bytes INTEGER,
      sensitivity TEXT NOT NULL DEFAULT 'private',
      retention_days INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compute_artifacts_job ON compute_artifacts(job_id);
  `);
}

function rowToJob(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    jobType: row.job_type,
    capability: row.capability,
    source: row.source,
    project: row.project,
    taskId: row.task_id,
    sessionId: row.session_id,
    rootExecutionId: row.root_execution_id,
    parentExecutionId: row.parent_execution_id,
    requestingActor: row.requesting_actor,
    dataClassification: row.data_classification,
    capabilityRequirements: parseJson(row.capability_requirements_json, {}),
    routingPreferences: parseJson(row.routing_preferences_json, {}),
    requestPayload: parseJson(row.request_payload_json, {}),
    selectedProviderId: row.selected_provider_id,
    selectedModelId: row.selected_model_id,
    selectedWorkerId: row.selected_worker_id,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    leaseRenewedAt: row.lease_renewed_at,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    status: row.status,
    progressPercent: row.progress_percent,
    progressMessage: row.progress_message,
    result: parseJson(row.result_json, null),
    resultHash: row.result_hash,
    errorCategory: row.error_category,
    errorMessage: row.error_message,
    fallbackHistory: parseJson(row.fallback_history_json, []),
    approvalRequired: row.approval_required === 1,
    approvalState: row.approval_state,
    inputHash: row.input_hash,
    timeoutMs: row.timeout_ms,
    startedAt: row.started_at,
    queuedAt: row.queued_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateTransition(currentStatus, newStatus) {
  const allowed = JOB_TRANSITIONS[currentStatus];
  if (!allowed) return false;
  return allowed.includes(newStatus);
}

function createJob({
  jobType, capability, source, project, taskId, sessionId,
  rootExecutionId, parentExecutionId, requestingActor,
  dataClassification = "private",
  capabilityRequirements = {}, routingPreferences = {},
  requestPayload = {}, approvalRequired = false,
  maxAttempts = 3, timeoutMs,
}) {
  ensureSchema();
  const jobId = generateId("job");
  const inputHash = crypto.createHash("sha256").update(json(requestPayload)).digest("hex").substring(0, 16);
  const initialStatus = approvalRequired ? "waiting_for_approval" : "queued";
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO compute_jobs (
      job_id, job_type, capability, source, project, task_id, session_id,
      root_execution_id, parent_execution_id, requesting_actor,
      data_classification, capability_requirements_json, routing_preferences_json,
      request_payload_json, max_attempts, status, approval_required, input_hash, timeout_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId, jobType, capability, source || null, project || null,
    taskId || null, sessionId || null, rootExecutionId || null,
    parentExecutionId || null, requestingActor || null,
    dataClassification, json(capabilityRequirements), json(routingPreferences),
    json(requestPayload), maxAttempts, initialStatus,
    approvalRequired ? 1 : 0, inputHash, timeoutMs || null
  );
  if (initialStatus === "queued") {
    db.prepare("UPDATE compute_jobs SET queued_at = ? WHERE job_id = ?").run(nowIso(), jobId);
  }
  return getJob(jobId);
}

function getJob(jobId) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_jobs WHERE job_id = ?").get(jobId);
  return rowToJob(row);
}

function listJobs({ status, jobType, project, providerId, workerId, capability, limit = 50 } = {}) {
  ensureSchema();
  const db = dbStore.getDb();
  let sql = "SELECT * FROM compute_jobs WHERE 1=1";
  const params = [];
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (jobType) { sql += " AND job_type = ?"; params.push(jobType); }
  if (project) { sql += " AND project = ?"; params.push(project); }
  if (providerId) { sql += " AND selected_provider_id = ?"; params.push(providerId); }
  if (workerId) { sql += " AND selected_worker_id = ?"; params.push(workerId); }
  if (capability) { sql += " AND capability = ?"; params.push(capability); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params).map(rowToJob);
}

function transitionJob(jobId, newStatus, details = {}) {
  ensureSchema();
  const db = dbStore.getDb();
  const job = getJob(jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", { jobId });
  if (!validateTransition(job.status, newStatus)) {
    throw new JobError(`Invalid transition: ${job.status} -> ${newStatus}`, "INVALID_TRANSITION", { jobId, from: job.status, to: newStatus });
  }
  const now = nowIso();
  const updates = { status: newStatus, updated_at: now };
  if (newStatus === "queued") updates.queued_at = now;
  if (newStatus === "running") updates.started_at = now;
  if (newStatus === "completed") updates.completed_at = now;
  if (newStatus === "cancelled") { updates.cancelled_at = now; updates.cancel_reason = details.cancelReason || null; }
  if (details.progressPercent !== undefined) updates.progress_percent = details.progressPercent;
  if (details.progressMessage !== undefined) updates.progress_message = details.progressMessage;
  if (details.result !== undefined) { updates.result_json = json(details.result); updates.result_hash = crypto.createHash("sha256").update(json(details.result)).digest("hex").substring(0, 16); }
  if (details.errorCategory !== undefined) updates.error_category = details.errorCategory;
  if (details.errorMessage !== undefined) updates.error_message = details.errorMessage;

  const setClauses = Object.keys(updates).map(k => k + " = ?");
  const params = Object.values(updates);
  params.push(jobId);
  db.prepare(`UPDATE compute_jobs SET ${setClauses.join(", ")} WHERE job_id = ?`).run(...params);
  return getJob(jobId);
}

function leaseJob(jobId, workerId, leaseDurationMs = 300000) {
  ensureSchema();
  const db = dbStore.getDb();
  const job = getJob(jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", { jobId });
  if (job.status !== "queued") throw new JobError("Job is not queued", "NOT_QUEUED", { jobId, status: job.status });

  const leaseId = generateId("lease");
  const leaseExpires = new Date(Date.now() + leaseDurationMs).toISOString();
  const now = nowIso();

  db.prepare(`
    UPDATE compute_jobs SET
      status = 'leased', lease_id = ?, lease_expires_at = ?, lease_renewed_at = ?,
      selected_worker_id = ?, attempt = attempt + 1, updated_at = ?
    WHERE job_id = ? AND status = 'queued'
  `).run(leaseId, leaseExpires, now, workerId, now, jobId);

  return getJob(jobId);
}

function renewLease(jobId, leaseId, leaseDurationMs = 300000) {
  ensureSchema();
  const db = dbStore.getDb();
  const job = getJob(jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", { jobId });
  if (job.leaseId !== leaseId) throw new LeaseExpiredError(jobId, leaseId);
  if (job.status !== "leased" && job.status !== "running") {
    throw new JobError("Job is not in a leaseable state", "NOT_LEASABLE", { jobId, status: job.status });
  }
  const now = nowIso();
  const newExpires = new Date(Date.now() + leaseDurationMs).toISOString();
  db.prepare("UPDATE compute_jobs SET lease_expires_at = ?, lease_renewed_at = ?, updated_at = ? WHERE job_id = ?")
    .run(newExpires, now, now, jobId);
  return getJob(jobId);
}

function checkLeaseExpiration() {
  ensureSchema();
  const db = dbStore.getDb();
  const now = nowIso();
  const expired = db.prepare(
    "SELECT job_id FROM compute_jobs WHERE status IN ('leased', 'running') AND lease_expires_at < ?"
  ).all(now);
  for (const { job_id } of expired) {
    try { transitionJob(job_id, "expired"); } catch {}
  }
  return expired.length;
}

function createAttempt(jobId, { providerId, modelId, workerId, leaseId }) {
  ensureSchema();
  const db = dbStore.getDb();
  const attemptId = generateId("attempt");
  const job = getJob(jobId);
  db.prepare(`
    INSERT INTO compute_job_attempts (attempt_id, job_id, attempt_number, provider_id, model_id, worker_id, lease_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(attemptId, jobId, job?.attempt || 1, providerId, modelId, workerId, leaseId);
  return attemptId;
}

function updateAttempt(attemptId, updates) {
  ensureSchema();
  const db = dbStore.getDb();
  const fields = [];
  const params = [];
  if (updates.status !== undefined) { fields.push("status = ?"); params.push(updates.status); }
  if (updates.completedAt !== undefined) { fields.push("completed_at = ?"); params.push(updates.completedAt); }
  if (updates.durationMs !== undefined) { fields.push("duration_ms = ?"); params.push(updates.durationMs); }
  if (updates.resultJson !== undefined) { fields.push("result_json = ?"); params.push(updates.resultJson); }
  if (updates.errorCategory !== undefined) { fields.push("error_category = ?"); params.push(updates.errorCategory); }
  if (updates.errorMessage !== undefined) { fields.push("error_message = ?"); params.push(updates.errorMessage); }
  if (updates.inputTokens !== undefined) { fields.push("input_tokens = ?"); params.push(updates.inputTokens); }
  if (updates.outputTokens !== undefined) { fields.push("output_tokens = ?"); params.push(updates.outputTokens); }
  if (updates.firstTokenLatencyMs !== undefined) { fields.push("first_token_latency_ms = ?"); params.push(updates.firstTokenLatencyMs); }
  if (updates.totalLatencyMs !== undefined) { fields.push("total_latency_ms = ?"); params.push(updates.totalLatencyMs); }
  if (updates.fallbackReason !== undefined) { fields.push("fallback_reason = ?"); params.push(updates.fallbackReason); }
  if (fields.length === 0) return;
  params.push(attemptId);
  db.prepare(`UPDATE compute_job_attempts SET ${fields.join(", ")} WHERE attempt_id = ?`).run(...params);
}

function createArtifact(jobId, { attemptId, artifactType, name, storagePath, storageRef, contentType, contentHash, sizeBytes, sensitivity = "private", retentionDays, metadata = {} }) {
  ensureSchema();
  const db = dbStore.getDb();
  const artifactId = generateId("art");
  db.prepare(`
    INSERT INTO compute_artifacts (
      artifact_id, job_id, attempt_id, artifact_type, name, storage_path, storage_ref,
      content_type, content_hash, size_bytes, sensitivity, retention_days, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(artifactId, jobId, attemptId || null, artifactType, name, storagePath || null, storageRef || null, contentType || null, contentHash || null, sizeBytes || 0, sensitivity, retentionDays || null, json(metadata));
  return artifactId;
}

function listArtifacts(jobId) {
  ensureSchema();
  const db = dbStore.getDb();
  return db.prepare("SELECT * FROM compute_artifacts WHERE job_id = ? ORDER BY created_at").all(jobId);
}

function getJobStats() {
  ensureSchema();
  const db = dbStore.getDb();
  const stats = db.prepare(`
    SELECT status, COUNT(*) as count FROM compute_jobs GROUP BY status
  `).all();
  const byType = db.prepare(`
    SELECT job_type, COUNT(*) as count FROM compute_jobs GROUP BY job_type
  `).all();
  const total = db.prepare("SELECT COUNT(*) as count FROM compute_jobs").get();
  return {
    total: total?.count || 0,
    byStatus: Object.fromEntries(stats.map(s => [s.status, s.count])),
    byType: Object.fromEntries(byType.map(t => [t.job_type, t.count])),
  };
}

module.exports = {
  ensureSchema,
  createJob,
  getJob,
  listJobs,
  transitionJob,
  leaseJob,
  renewLease,
  checkLeaseExpiration,
  createAttempt,
  updateAttempt,
  createArtifact,
  listArtifacts,
  getJobStats,
  rowToJob,
};
