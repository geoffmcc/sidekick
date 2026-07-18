const crypto = require("crypto");
const dbStore = require("../db");
const { JOB_STATES, JOB_TERMINAL_STATES, JOB_TRANSITIONS, JobError, LeaseExpiredError } = require("./errors");
const { validateJobContract } = require("./job-contract");
const placement = require("./placement");
const manifest = require("./openvino-model-manifest");
let platformKernel = null;
try { platformKernel = require("../platform/kernel"); } catch {}

function nowIso() { return new Date().toISOString(); }
function generateId(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`; }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function json(value) { return JSON.stringify(value || {}); }
function hashJson(value) { return crypto.createHash("sha256").update(json(value)).digest("hex"); }
function parseMaybeArray(value) { return Array.isArray(value) ? value : []; }

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
      protocol_version TEXT NOT NULL DEFAULT '1',
      capability_requirements_json TEXT NOT NULL DEFAULT '{}',
      routing_preferences_json TEXT NOT NULL DEFAULT '{}',
      retry_policy_json TEXT NOT NULL DEFAULT '{}',
      resource_requirements_json TEXT NOT NULL DEFAULT '{}',
      artifact_expectations_json TEXT NOT NULL DEFAULT '[]',
      output_limits_json TEXT NOT NULL DEFAULT '{}',
      scheduling_diagnostics_json TEXT NOT NULL DEFAULT '{}',
      request_payload_json TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 50,
      expires_at TEXT,
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
      retry_after TEXT,
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
      worker_id TEXT,
      lease_id TEXT,
      state TEXT NOT NULL DEFAULT 'finalized',
      finalized_at TEXT,
      sensitivity TEXT NOT NULL DEFAULT 'private',
      retention_days INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compute_artifacts_job ON compute_artifacts(job_id);
  `);
  ensureColumn("compute_jobs", "cancel_requested_at", "TEXT");
  ensureColumn("compute_jobs", "cancel_requested_by", "TEXT");
  ensureColumn("compute_jobs", "cancel_acknowledged_at", "TEXT");
  ensureColumn("compute_jobs", "cancel_acknowledged_by", "TEXT");
  ensureColumn("compute_jobs", "idempotency_key", "TEXT");
  ensureColumn("compute_jobs", "protocol_version", "TEXT NOT NULL DEFAULT '1'");
  ensureColumn("compute_jobs", "priority", "INTEGER NOT NULL DEFAULT 50");
  ensureColumn("compute_jobs", "expires_at", "TEXT");
  ensureColumn("compute_jobs", "retry_policy_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("compute_jobs", "resource_requirements_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("compute_jobs", "artifact_expectations_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("compute_jobs", "output_limits_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("compute_jobs", "retry_after", "TEXT");
  ensureColumn("compute_jobs", "scheduling_diagnostics_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("compute_job_attempts", "progress_percent", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("compute_job_attempts", "progress_message", "TEXT");
  ensureColumn("compute_job_attempts", "lease_acquired_at", "TEXT");
  ensureColumn("compute_job_attempts", "lease_expires_at", "TEXT");
  ensureColumn("compute_job_attempts", "execution_id", "TEXT");
  // Placement v1 provenance: what was asked for vs what actually ran, and how
  // the actual-device claim was verified against the model manifest.
  ensureColumn("compute_job_attempts", "requested_accelerator", "TEXT");
  ensureColumn("compute_job_attempts", "accelerator_verification", "TEXT");
  ensureColumn("compute_artifacts", "worker_id", "TEXT");
  ensureColumn("compute_artifacts", "lease_id", "TEXT");
  ensureColumn("compute_artifacts", "state", "TEXT NOT NULL DEFAULT 'finalized'");
  ensureColumn("compute_artifacts", "finalized_at", "TEXT");
}

function ensureColumn(table, column, definition) {
  const db = dbStore.getDb();
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    protocolVersion: row.protocol_version || "1",
    capabilityRequirements: parseJson(row.capability_requirements_json, {}),
    routingPreferences: parseJson(row.routing_preferences_json, {}),
    retryPolicy: parseJson(row.retry_policy_json, {}),
    resourceRequirements: parseJson(row.resource_requirements_json, {}),
    artifactExpectations: parseJson(row.artifact_expectations_json, []),
    outputLimits: parseJson(row.output_limits_json, {}),
    schedulingDiagnostics: parseJson(row.scheduling_diagnostics_json, {}),
    requestPayload: parseJson(row.request_payload_json, {}),
    priority: row.priority,
    expiresAt: row.expires_at,
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
    retryAfter: row.retry_after,
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
    cancelRequestedAt: row.cancel_requested_at,
    cancelRequestedBy: row.cancel_requested_by,
    cancelAcknowledgedAt: row.cancel_acknowledged_at,
    cancelAcknowledgedBy: row.cancel_acknowledged_by,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToArtifact(row) {
  if (!row) return null;
  return {
    artifactId: row.artifact_id,
    artifact_id: row.artifact_id,
    jobId: row.job_id,
    job_id: row.job_id,
    attemptId: row.attempt_id,
    attempt_id: row.attempt_id,
    workerId: row.worker_id,
    worker_id: row.worker_id,
    leaseId: row.lease_id,
    lease_id: row.lease_id,
    artifactType: row.artifact_type,
    artifact_type: row.artifact_type,
    name: row.name,
    storagePath: row.storage_path,
    storage_path: row.storage_path,
    storageRef: row.storage_ref,
    storage_ref: row.storage_ref,
    contentType: row.content_type,
    content_type: row.content_type,
    contentHash: row.content_hash,
    content_hash: row.content_hash,
    sizeBytes: row.size_bytes,
    size_bytes: row.size_bytes,
    state: row.state || "finalized",
    finalizedAt: row.finalized_at,
    finalized_at: row.finalized_at,
    sensitivity: row.sensitivity,
    retentionDays: row.retention_days,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function rowToAttempt(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    attempt_id: row.attempt_id,
    jobId: row.job_id,
    job_id: row.job_id,
    attemptNumber: row.attempt_number,
    attempt_number: row.attempt_number,
    providerId: row.provider_id,
    provider_id: row.provider_id,
    modelId: row.model_id,
    model_id: row.model_id,
    workerId: row.worker_id,
    worker_id: row.worker_id,
    leaseId: row.lease_id,
    lease_id: row.lease_id,
    status: row.status,
    startedAt: row.started_at,
    started_at: row.started_at,
    completedAt: row.completed_at,
    completed_at: row.completed_at,
    durationMs: row.duration_ms,
    duration_ms: row.duration_ms,
    progressPercent: row.progress_percent,
    progress_percent: row.progress_percent,
    progressMessage: row.progress_message,
    progress_message: row.progress_message,
    leaseAcquiredAt: row.lease_acquired_at,
    lease_acquired_at: row.lease_acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    lease_expires_at: row.lease_expires_at,
    executionId: row.execution_id,
    execution_id: row.execution_id,
    errorCategory: row.error_category,
    error_category: row.error_category,
    errorMessage: row.error_message,
    error_message: row.error_message,
    accelerator: row.accelerator,
    requestedAccelerator: row.requested_accelerator,
    requested_accelerator: row.requested_accelerator,
    acceleratorVerification: row.accelerator_verification,
    accelerator_verification: row.accelerator_verification,
    fallbackReason: row.fallback_reason,
    fallback_reason: row.fallback_reason,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    created_at: row.created_at,
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
  retryPolicy = {}, resourceRequirements = {}, artifactExpectations = [], outputLimits = {},
  requestPayload = {}, approvalRequired = false,
  maxAttempts = 3, timeoutMs, priority = 50, expiresAt, protocolVersion = "1",
  idempotencyKey,
}) {
  ensureSchema();
  const validated = validateJobContract({ protocolVersion, jobType, capability, requestPayload, capabilityRequirements, routingPreferences, retryPolicy, resourceRequirements, artifactExpectations, outputLimits, priority, timeoutMs, expiresAt });
  // Placement choke point: callers must not smuggle infrastructure selection,
  // credentials, device/worker pinning, trust claims, or provenance into the
  // job's free-form objects. Rejected explicitly, never silently dropped.
  placement.assertNoForbiddenFields({ requestPayload, capabilityRequirements, routingPreferences }, "job", { allow: [] });
  jobType = validated.jobType;
  capability = validated.capability;
  protocolVersion = validated.protocolVersion;
  priority = validated.priority;
  const jobId = generateId("job");
  const inputHash = hashJson(requestPayload);
  const initialStatus = approvalRequired ? "waiting_for_approval" : "queued";
  const db = dbStore.getDb();
  if (idempotencyKey) {
    const existing = db.prepare("SELECT * FROM compute_jobs WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return rowToJob(existing);
  }
  db.prepare(`
    INSERT INTO compute_jobs (
      job_id, job_type, capability, source, project, task_id, session_id,
      root_execution_id, parent_execution_id, requesting_actor,
      data_classification, protocol_version, capability_requirements_json, routing_preferences_json,
      retry_policy_json, resource_requirements_json, artifact_expectations_json, output_limits_json,
      request_payload_json, priority, expires_at, max_attempts, status, approval_required, input_hash, timeout_ms,
      idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId, jobType, capability, source || null, project || null,
    taskId || null, sessionId || null, rootExecutionId || null,
    parentExecutionId || null, requestingActor || null,
    dataClassification, protocolVersion, json(capabilityRequirements), json(routingPreferences),
    json(retryPolicy), json(resourceRequirements), json(artifactExpectations), json(outputLimits),
    json(requestPayload), priority, expiresAt || null, maxAttempts, initialStatus,
    approvalRequired ? 1 : 0, inputHash, timeoutMs || null,
    idempotencyKey || null
  );
  if (initialStatus === "queued") {
    db.prepare("UPDATE compute_jobs SET queued_at = ? WHERE job_id = ?").run(nowIso(), jobId);
  }
  return getJob(jobId);
}

function workerCanRunJob(worker, job) {
  return workerCompatibility(worker, job).ok;
}

// Map the placement core's sanitized reason codes onto the legacy diagnostic
// strings this path has always recorded, so scheduling_diagnostics_json stays
// backward compatible for existing consumers and tests.
function legacyCompatReason(code, worker, requiredExecutor, requiredModel) {
  switch (code) {
    case "worker_offline": return `state:${worker.state}`;
    case "worker_maintenance": return "maintenance_mode";
    case "protocol_mismatch": return `protocol:${worker.protocolVersion || "missing"}`;
    case "concurrency_exhausted": return "concurrency_limit";
    case "worker_stale": return "heartbeat_stale";
    case "executor_missing": return `executor_missing:${requiredExecutor}`;
    case "model_missing": return `model_missing:${requiredModel}`;
    default: return code;
  }
}

function jobPlacementRequirement(job) {
  const trustRequested = job.routingPreferences?.trust_level_required;
  return {
    capability: job.capability || job.jobType,
    dataClassification: job.dataClassification || "private",
    // Workers enroll at "trusted" by default; a job may only RAISE the floor.
    trustLevelRequired: placement.TRUST_ORDER[trustRequested] !== undefined && placement.TRUST_ORDER[trustRequested] > placement.TRUST_ORDER.trusted ? trustRequested : "trusted",
    requirements: {
      sequenceLength: Number.isInteger(job.capabilityRequirements?.sequence_length) ? job.capabilityRequirements.sequence_length : null,
      dimensions: Number.isInteger(job.capabilityRequirements?.dimensions) ? job.capabilityRequirements.dimensions : null,
    },
  };
}

function workerCompatibility(worker, job, { activeExecutorCounts = null } = {}) {
  if (!worker) return { ok: false, reasons: ["worker_missing"], bestTier: null };
  const requiredExecutor = job.capabilityRequirements?.executor || job.requestPayload?.executor;
  const requiredModel = job.requestPayload?.model || job.requestPayload?.model_id || job.capabilityRequirements?.model;

  // Shared placement predicate: lifecycle, staleness, concurrency (worker-wide
  // and per-executor), data classification, trust, executor/model presence,
  // and manifest-authoritative certification all evaluate here — the same code
  // that backs explainPlacement, so claim decisions and dry runs cannot drift.
  const evaluation = placement.evaluateWorkerCandidate(
    jobPlacementRequirement(job), worker, { executor: requiredExecutor, model: requiredModel }, { activeExecutorCounts }
  );
  const reasons = evaluation.reasons.map(code => legacyCompatReason(code, worker, requiredExecutor, requiredModel));

  // Job-path-specific: job type ↔ executor-family capability check.
  const executors = parseMaybeArray(worker.executors).map(e => typeof e === "string" ? e : (e.type || e.name)).filter(Boolean);
  const providers = parseMaybeArray(worker.providers).map(p => typeof p === "string" ? p : (p.type || p.providerType || p.name)).filter(Boolean);
  let capabilityOk = false;
  if (["chat", "generate", "embedding", "embeddings", "inference"].includes(job.jobType) || ["chat", "generate", "embeddings"].includes(job.capability)) {
    capabilityOk = executors.includes("mock.inference") || executors.includes("ollama.inference") || providers.includes("mock") || providers.includes("ollama");
  }
  capabilityOk = capabilityOk || executors.includes(job.jobType) || executors.includes(job.capability);
  if (!capabilityOk) reasons.push(`capability_missing:${job.capability || job.jobType}`);

  return { ok: reasons.length === 0, reasons, bestTier: evaluation.tier };
}

function recordSchedulingDiagnostics(db, jobId, diagnostics) {
  db.prepare("UPDATE compute_jobs SET scheduling_diagnostics_json = ?, updated_at = ? WHERE job_id = ?")
    .run(json(diagnostics), nowIso(), jobId);
}

function createPlatformExecutionForJob(job, workerId) {
  if (!platformKernel) return null;
  try {
    const execution = platformKernel.createExecution({
      execution_id: job.rootExecutionId || undefined,
      task_id: job.taskId,
      session_id: job.sessionId,
      project_id: job.project,
      actor_id: workerId || job.requestingActor || "compute",
      trigger_type: "compute",
      operation_type: "compute_job",
      tool_name: "compute",
      tool_action: job.capability || job.jobType,
      state: "created",
      risk: job.dataClassification === "public" ? "low" : "medium",
      metadata: { job_id: job.jobId, job_type: job.jobType, capability: job.capability },
      source: "compute",
    });
    return execution?.execution_id || null;
  } catch { return null; }
}

function emitComputeEvent(eventType, job, payload = {}, severity = "info") {
  if (!platformKernel || !job?.rootExecutionId) return;
  try {
    platformKernel.appendEvent({
      event_type: eventType,
      source: "compute",
      execution_id: job.rootExecutionId,
      root_execution_id: job.rootExecutionId,
      project_id: job.project,
      task_id: job.taskId,
      session_id: job.sessionId,
      subject_type: "compute_job",
      subject_id: job.jobId,
      severity,
      payload,
      correlation_id: job.rootExecutionId,
    });
  } catch {}
}

// Whether a worker is allowed to claim new work, based on the multi-dimensional
// lifecycle state. A worker in maintenance/draining stays connected and keeps
// its leases but must not pick up NEW jobs; a revoked credential is terminal
// (defense-in-depth — authentication already rejects revoked workers).
function workerEligibleToClaim(worker) {
  if (!worker) return { ok: false, reason: "unknown_worker" };
  if (worker.credentialState === "revoked" || worker.state === "revoked") return { ok: false, reason: "credential_revoked" };
  if (worker.adminState === "maintenance") return { ok: false, reason: "in_maintenance" };
  if (worker.adminState === "draining") return { ok: false, reason: "draining" };
  return { ok: true };
}

function claimNextJob(worker, { leaseDurationMs = 300000 } = {}) {
  ensureSchema();
  const eligibility = workerEligibleToClaim(worker);
  if (!eligibility.ok) return { ineligible: eligibility.reason };
  const db = dbStore.getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    releaseRetryWaitJobs(db);
    // Authoritative concurrency state is re-read INSIDE the transaction: the
    // caller-supplied worker snapshot was captured at authentication time and
    // two near-simultaneous claims would otherwise both pass the guard.
    const freshCounts = db.prepare("SELECT current_jobs, max_concurrent_jobs FROM compute_workers WHERE worker_id = ?").get(worker.workerId);
    const freshWorker = freshCounts
      ? { ...worker, currentJobs: freshCounts.current_jobs, maxConcurrentJobs: freshCounts.max_concurrent_jobs }
      : worker;
    // Active per-executor leases for this worker: executors with a declared
    // concurrency limit (the OpenVINO helper holds a single resident NPU
    // model) must not be double-claimed even when the worker-wide limit has
    // headroom.
    const activeExecutorCounts = {};
    for (const active of db.prepare("SELECT capability_requirements_json, request_payload_json FROM compute_jobs WHERE selected_worker_id = ? AND status IN ('leased','starting','running')").all(worker.workerId)) {
      const executor = parseJson(active.capability_requirements_json, {}).executor || parseJson(active.request_payload_json, {}).executor;
      if (executor) activeExecutorCounts[executor] = (activeExecutorCounts[executor] || 0) + 1;
    }
    const rows = db.prepare("SELECT * FROM compute_jobs WHERE status = 'queued' AND attempt < max_attempts AND (expires_at IS NULL OR expires_at > ?) ORDER BY priority ASC, created_at ASC LIMIT 50").all(nowIso());
    for (const row of rows) {
      const job = rowToJob(row);
      const compatibility = workerCompatibility(freshWorker, job, { activeExecutorCounts });
      if (!compatibility.ok) {
        recordSchedulingDiagnostics(db, job.jobId, { selected: false, workerId: worker.workerId, rejected: [{ workerId: worker.workerId, reasons: compatibility.reasons }], checkedAt: nowIso() });
        continue;
      }
      const leaseId = generateId("lease");
      const now = nowIso();
      const leaseExpires = new Date(Date.now() + leaseDurationMs).toISOString();
      const executionId = job.rootExecutionId || createPlatformExecutionForJob(job, worker.workerId);
      const result = db.prepare(`
        UPDATE compute_jobs SET status = 'leased', lease_id = ?, lease_expires_at = ?, lease_renewed_at = ?,
          selected_worker_id = ?, attempt = attempt + 1, updated_at = ?, root_execution_id = COALESCE(root_execution_id, ?)
        WHERE job_id = ? AND status = 'queued' AND attempt < max_attempts
      `).run(leaseId, leaseExpires, now, worker.workerId, now, executionId, job.jobId);
      if (result.changes !== 1) continue;
      const leased = rowToJob(db.prepare("SELECT * FROM compute_jobs WHERE job_id = ?").get(job.jobId));
      const attemptId = generateId("attempt");
      db.prepare(`
        INSERT INTO compute_job_attempts (attempt_id, job_id, attempt_number, worker_id, lease_id, status, lease_acquired_at, lease_expires_at, execution_id)
        VALUES (?, ?, ?, ?, ?, 'leased', ?, ?, ?)
      `).run(attemptId, job.jobId, leased.attempt, worker.workerId, leaseId, now, leaseExpires, executionId || null);
      recordSchedulingDiagnostics(db, job.jobId, { selected: true, workerId: worker.workerId, reasons: ["compatible"], bestTier: compatibility.bestTier, checkedAt: now });
      db.prepare("UPDATE compute_workers SET current_jobs = current_jobs + 1, updated_at = ? WHERE worker_id = ?").run(now, worker.workerId);
      db.exec("COMMIT");
      emitComputeEvent("compute.job_leased", leased, { worker_id: worker.workerId, lease_id: leaseId, attempt_id: attemptId });
      return { job: getJob(job.jobId), attemptId, leaseId };
    }
    db.exec("COMMIT");
    return null;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

function releaseRetryWaitJobs(db = dbStore.getDb()) {
  const now = nowIso();
  db.prepare("UPDATE compute_jobs SET status = 'queued', queued_at = ?, updated_at = ?, retry_after = NULL WHERE status = 'retry_wait' AND retry_after <= ?")
    .run(now, now, now);
}

function retryDelayMs(job) {
  const policy = job.retryPolicy || {};
  const base = Number(policy.backoffMs || policy.initialBackoffMs || 1000);
  const max = Number(policy.maxBackoffMs || 60000);
  const attemptIndex = Math.max(0, Number(job.attempt || 1) - 1);
  const delay = Math.min(max, base * Math.pow(2, attemptIndex));
  return Math.max(0, Number.isFinite(delay) ? delay : 1000);
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
  if (job.leaseId !== leaseId || (job.leaseExpiresAt && new Date(job.leaseExpiresAt) < new Date())) throw new LeaseExpiredError(jobId, leaseId);
  if (job.status !== "leased" && job.status !== "running") {
    throw new JobError("Job is not in a leaseable state", "NOT_LEASABLE", { jobId, status: job.status });
  }
  const now = nowIso();
  const newExpires = new Date(Date.now() + leaseDurationMs).toISOString();
  db.prepare("UPDATE compute_jobs SET lease_expires_at = ?, lease_renewed_at = ?, updated_at = ? WHERE job_id = ? AND lease_id = ?")
    .run(newExpires, now, now, jobId, leaseId);
  db.prepare("UPDATE compute_job_attempts SET lease_expires_at = ? WHERE job_id = ? AND lease_id = ?").run(newExpires, jobId, leaseId);
  return getJob(jobId);
}

function recoverExpiredLeases() {
  ensureSchema();
  const db = dbStore.getDb();
  const now = nowIso();
  const rows = db.prepare("SELECT * FROM compute_jobs WHERE status IN ('leased', 'running') AND lease_expires_at < ?").all(now);
  for (const row of rows) {
    const exhausted = row.attempt >= row.max_attempts;
    const nextStatus = exhausted ? "dead_letter" : "retry_wait";
    db.prepare(`
      UPDATE compute_jobs SET status = ?, lease_id = NULL, lease_expires_at = NULL, lease_renewed_at = NULL,
        selected_worker_id = NULL, error_category = ?, error_message = ?, retry_after = ?, updated_at = ?
      WHERE job_id = ?
    `).run(nextStatus, exhausted ? "attempts_exhausted" : "lease_expired", "Worker lease expired", exhausted ? null : new Date(Date.now() + retryDelayMs(rowToJob(row))).toISOString(), now, row.job_id);
    db.prepare("UPDATE compute_job_attempts SET status = ?, completed_at = ?, error_category = 'lease_expired', error_message = 'Worker lease expired' WHERE job_id = ? AND lease_id = ?")
      .run(exhausted ? "dead_letter" : "expired", now, row.job_id, row.lease_id);
    if (row.selected_worker_id) db.prepare("UPDATE compute_workers SET current_jobs = MAX(current_jobs - 1, 0), updated_at = ? WHERE worker_id = ?").run(now, row.selected_worker_id);
  }
  return rows.length;
}

function checkLeaseExpiration() { return recoverExpiredLeases(); }

function assertLeaseOwner(jobId, workerId, leaseId, allowedStates = ["leased", "starting", "running"]) {
  const job = getJob(jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", { jobId });
  if (job.selectedWorkerId !== workerId || job.leaseId !== leaseId) throw new LeaseExpiredError(jobId, leaseId);
  if (job.leaseExpiresAt && new Date(job.leaseExpiresAt) < new Date()) throw new LeaseExpiredError(jobId, leaseId);
  if (!allowedStates.includes(job.status)) throw new JobError("Job is not in an allowed state", "INVALID_STATE", { jobId, status: job.status });
  return job;
}

function startLeasedJob(jobId, workerId, leaseId) {
  ensureSchema();
  const job = assertLeaseOwner(jobId, workerId, leaseId, ["leased", "starting", "running"]);
  if (job.status === "running") return job;
  if (job.status === "leased") transitionJob(jobId, "starting");
  const running = transitionJob(jobId, "running");
  const db = dbStore.getDb();
  db.prepare("UPDATE compute_job_attempts SET status = 'running', started_at = COALESCE(started_at, ?) WHERE job_id = ? AND lease_id = ?").run(nowIso(), jobId, leaseId);
  if (platformKernel && running.rootExecutionId) {
    try { platformKernel.transitionExecution(running.rootExecutionId, "running", { source: "compute", actor_id: workerId, reason: "worker started job" }); } catch {}
  }
  emitComputeEvent("compute.job_started", running, { worker_id: workerId, lease_id: leaseId });
  return running;
}

function updateProgress(jobId, workerId, leaseId, { progressPercent, progressMessage }) {
  ensureSchema();
  const percent = Math.max(0, Math.min(100, Number.isFinite(Number(progressPercent)) ? Math.floor(Number(progressPercent)) : 0));
  const message = progressMessage ? String(progressMessage).slice(0, 500) : null;
  const job = assertLeaseOwner(jobId, workerId, leaseId, ["leased", "starting", "running", "cancelling"]);
  const db = dbStore.getDb();
  db.prepare("UPDATE compute_jobs SET progress_percent = ?, progress_message = ?, updated_at = ? WHERE job_id = ? AND lease_id = ?")
    .run(percent, message, nowIso(), jobId, leaseId);
  db.prepare("UPDATE compute_job_attempts SET progress_percent = ?, progress_message = ? WHERE job_id = ? AND lease_id = ?")
    .run(percent, message, jobId, leaseId);
  emitComputeEvent("compute.job_progress", job, { worker_id: workerId, progress_percent: percent, progress_message: message });
  return getJob(jobId);
}

/**
 * Derive accelerator provenance for a completing attempt. The worker's claimed
 * device is cross-checked against the model manifest — a worker result can
 * never upgrade recorded provenance beyond what the manifest permits for the
 * job's model:
 *   - claimed == certifiedDevice                     -> manifest_confirmed
 *   - claimed == fallbackDevice && fallback occurred -> manifest_confirmed_fallback
 *   - claimed outside the manifest-permitted set     -> rejected_claim (no accelerator recorded)
 *   - model not manifest-listed (e.g. ollama chat)   -> unverified (claim recorded as claim only)
 */
function deriveAttemptProvenance(job, result) {
  const claimed = typeof result?.device === "string" ? result.device : null;
  const requested = typeof result?.requested_device === "string" ? result.requested_device : null;
  const fallbackOccurred = result?.fallback_occurred === true;
  const fallbackReason = typeof result?.fallback_reason === "string" ? result.fallback_reason.slice(0, 200) : null;
  const modelName = job.requestPayload?.model || job.requestPayload?.model_id || job.capabilityRequirements?.model || null;
  const approved = modelName ? manifest.getApprovedModel(modelName) : null;
  if (!claimed) {
    return { accelerator: null, requestedAccelerator: requested, verification: null, fallbackOccurred, fallbackReason };
  }
  if (!approved) {
    return { accelerator: claimed, requestedAccelerator: requested, verification: "unverified", fallbackOccurred, fallbackReason };
  }
  if (claimed === approved.certifiedDevice && !fallbackOccurred) {
    return { accelerator: claimed, requestedAccelerator: requested || approved.certifiedDevice, verification: "manifest_confirmed", fallbackOccurred, fallbackReason };
  }
  if (fallbackOccurred && approved.fallbackDevice && claimed === approved.fallbackDevice) {
    return { accelerator: claimed, requestedAccelerator: requested || approved.certifiedDevice, verification: "manifest_confirmed_fallback", fallbackOccurred, fallbackReason };
  }
  return { accelerator: null, requestedAccelerator: requested || approved.certifiedDevice, verification: "rejected_claim", fallbackOccurred, fallbackReason };
}

function appendFallbackHistory(db, jobId, entry, existing) {
  const history = Array.isArray(existing) ? existing.slice(-19) : [];
  history.push(entry);
  db.prepare("UPDATE compute_jobs SET fallback_history_json = ? WHERE job_id = ?").run(JSON.stringify(history), jobId);
}

function completeJob(jobId, workerId, leaseId, { result = {}, artifacts = [], artifactIds = [], artifact_ids = [] } = {}) {
  ensureSchema();
  const job = getJob(jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", { jobId });
  if (job.status === "completed") return job;
  assertLeaseOwner(jobId, workerId, leaseId, ["leased", "starting", "running"]);
  validateCompletionArtifacts(jobId, workerId, leaseId, artifactIds.length ? artifactIds : artifact_ids);
  const db = dbStore.getDb();
  const now = nowIso();
  const provenance = deriveAttemptProvenance(job, result);
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare(`
      UPDATE compute_jobs SET status = 'completed', progress_percent = 100, result_json = ?, result_hash = ?, completed_at = ?, updated_at = ?
      WHERE job_id = ? AND selected_worker_id = ? AND lease_id = ? AND status IN ('leased','starting','running')
    `).run(json(result), hashJson(result), now, now, jobId, workerId, leaseId);
    if (update.changes !== 1) throw new LeaseExpiredError(jobId, leaseId);
    // Provenance is written under the same lease-scoped guard as the result
    // itself, so a superseded attempt can never record or overwrite it.
    db.prepare(`
      UPDATE compute_job_attempts SET status = 'completed', completed_at = ?, result_json = ?, result_hash = ?,
        accelerator = ?, requested_accelerator = ?, accelerator_verification = ?, fallback_reason = COALESCE(?, fallback_reason)
      WHERE job_id = ? AND lease_id = ?
    `).run(now, json(result), hashJson(result), provenance.accelerator, provenance.requestedAccelerator, provenance.verification, provenance.fallbackReason, jobId, leaseId);
    if (provenance.fallbackOccurred || provenance.verification === "rejected_claim") {
      appendFallbackHistory(db, jobId, {
        attempt: job.attempt,
        requested_accelerator: provenance.requestedAccelerator,
        accelerator: provenance.accelerator,
        fallback_occurred: provenance.fallbackOccurred,
        fallback_reason: provenance.fallbackReason,
        verification: provenance.verification,
        at: now,
      }, job.fallbackHistory);
    }
    db.prepare("UPDATE compute_workers SET current_jobs = MAX(current_jobs - 1, 0), updated_at = ? WHERE worker_id = ?").run(now, workerId);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
  const completed = getJob(jobId);
  for (const artifact of parseMaybeArray(artifacts).slice(0, 10)) {
    createVerifiedArtifact(jobId, leaseId, workerId, artifact, completed.rootExecutionId);
  }
  if (platformKernel && completed.rootExecutionId) {
    try { platformKernel.transitionExecution(completed.rootExecutionId, "completed", { source: "compute", actor_id: workerId, result_status: "success", result_summary: "compute job completed" }); } catch {}
  }
  emitComputeEvent("compute.job_completed", completed, { worker_id: workerId, lease_id: leaseId });
  return completed;
}

function validateCompletionArtifacts(jobId, workerId, leaseId, artifactIds) {
  for (const artifactId of parseMaybeArray(artifactIds).slice(0, 20)) {
    const artifact = getArtifact(String(artifactId));
    if (!artifact || artifact.jobId !== jobId) throw new JobError("Artifact not found", "ARTIFACT_NOT_FOUND", { jobId, artifactId });
    if (artifact.workerId !== workerId || artifact.leaseId !== leaseId) throw new LeaseExpiredError(jobId, leaseId);
    if (artifact.state !== "finalized") throw new JobError("Artifact is not finalized", "ARTIFACT_NOT_FINALIZED", { jobId, artifactId });
  }
}

function failJob(jobId, workerId, leaseId, { errorCategory = "worker_error", errorMessage = "Worker reported failure" } = {}) {
  ensureSchema();
  assertLeaseOwner(jobId, workerId, leaseId, ["leased", "starting", "running"]);
  const db = dbStore.getDb();
  const current = getJob(jobId);
  const nextStatus = current.attempt >= current.maxAttempts ? "dead_letter" : "retry_wait";
  const retryAfter = nextStatus === "retry_wait" ? new Date(Date.now() + retryDelayMs(current)).toISOString() : null;
  const now = nowIso();
  // Failed attempts are part of the placement/fallback record: what failed,
  // why, and whether a retry (re-placement) follows.
  appendFallbackHistory(db, jobId, {
    attempt: current.attempt,
    failed: true,
    error_category: String(errorCategory).slice(0, 80),
    next_status: nextStatus,
    at: now,
  }, current.fallbackHistory);
  db.prepare(`
    UPDATE compute_jobs SET status = ?, lease_id = NULL, lease_expires_at = NULL, lease_renewed_at = NULL, selected_worker_id = NULL,
      error_category = ?, error_message = ?, retry_after = ?, updated_at = ?
    WHERE job_id = ? AND lease_id = ?
  `).run(nextStatus, String(errorCategory).slice(0, 80), String(errorMessage).slice(0, 1000), retryAfter, now, jobId, leaseId);
  db.prepare("UPDATE compute_job_attempts SET status = ?, completed_at = ?, error_category = ?, error_message = ? WHERE job_id = ? AND lease_id = ?")
    .run(nextStatus === "retry_wait" ? "failed" : "dead_letter", now, String(errorCategory).slice(0, 80), String(errorMessage).slice(0, 1000), jobId, leaseId);
  db.prepare("UPDATE compute_workers SET current_jobs = MAX(current_jobs - 1, 0), updated_at = ? WHERE worker_id = ?").run(now, workerId);
  const job = getJob(jobId);
  emitComputeEvent("compute.job_failed", job, { worker_id: workerId, lease_id: leaseId, next_status: nextStatus }, "warning");
  return job;
}

function cancelJob(jobId, { actor = "admin", reason = "cancelled" } = {}) {
  ensureSchema();
  const db = dbStore.getDb();
  const job = getJob(jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", { jobId });
  if (JOB_TERMINAL_STATES.has(job.status)) return job;
  const now = nowIso();
  db.prepare("UPDATE compute_jobs SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, cancel_requested_at = ?, cancel_requested_by = ?, updated_at = ? WHERE job_id = ?")
    .run(now, String(reason).slice(0, 500), now, String(actor).slice(0, 120), now, jobId);
  if (job.leaseId) db.prepare("UPDATE compute_job_attempts SET status = 'cancelled', completed_at = ? WHERE job_id = ? AND lease_id = ?").run(now, jobId, job.leaseId);
  if (job.selectedWorkerId) db.prepare("UPDATE compute_workers SET current_jobs = MAX(current_jobs - 1, 0), updated_at = ? WHERE worker_id = ?").run(now, job.selectedWorkerId);
  const cancelled = getJob(jobId);
  if (platformKernel && cancelled.rootExecutionId) {
    try { platformKernel.transitionExecution(cancelled.rootExecutionId, "cancelled", { source: "compute", actor_id: actor, reason }); } catch {}
  }
  emitComputeEvent("compute.job_cancelled", cancelled, { actor, reason }, "warning");
  return cancelled;
}

function getCancellationStatus(jobId, workerId, leaseId) {
  ensureSchema();
  const job = getJob(jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", { jobId });
  if (job.selectedWorkerId !== workerId || job.leaseId !== leaseId) throw new LeaseExpiredError(jobId, leaseId);
  return {
    cancelled: job.status === "cancelled" || job.status === "cancelling" || !!job.cancelRequestedAt,
    status: job.status,
    reason: job.cancelReason || null,
    requestedAt: job.cancelRequestedAt || null,
    requestedBy: job.cancelRequestedBy || null,
    acknowledgedAt: job.cancelAcknowledgedAt || null,
  };
}

function acknowledgeCancellation(jobId, workerId, leaseId) {
  ensureSchema();
  const status = getCancellationStatus(jobId, workerId, leaseId);
  if (!status.cancelled) throw new JobError("Job cancellation has not been requested", "CANCEL_NOT_REQUESTED", { jobId });
  const now = nowIso();
  dbStore.getDb().prepare("UPDATE compute_jobs SET cancel_acknowledged_at = COALESCE(cancel_acknowledged_at, ?), cancel_acknowledged_by = COALESCE(cancel_acknowledged_by, ?), updated_at = ? WHERE job_id = ?")
    .run(now, workerId, now, jobId);
  const job = getJob(jobId);
  emitComputeEvent("compute.job_cancel_acknowledged", job, { worker_id: workerId, lease_id: leaseId }, "warning");
  return job;
}

function retryJob(jobId, { actor = "admin", reason = "retry_requested" } = {}) {
  ensureSchema();
  const db = dbStore.getDb();
  const job = getJob(jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", { jobId });
  if (!["failed", "expired", "dead_letter", "cancelled"].includes(job.status)) {
    throw new JobError("Job is not retryable", "NOT_RETRYABLE", { jobId, status: job.status });
  }
  const now = nowIso();
  db.prepare(`
    UPDATE compute_jobs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, lease_renewed_at = NULL,
      selected_worker_id = NULL, progress_percent = 0, progress_message = NULL, retry_after = NULL, error_category = NULL,
      error_message = NULL, queued_at = ?, updated_at = ?, max_attempts = MAX(max_attempts, attempt + 1)
    WHERE job_id = ?
  `).run(now, now, jobId);
  const retried = getJob(jobId);
  emitComputeEvent("compute.job_retry_requested", retried, { actor, reason }, "info");
  return retried;
}

function createVerifiedArtifact(jobId, leaseId, workerId, artifact, executionId) {
  assertLeaseOwner(jobId, workerId, leaseId, ["leased", "starting", "running", "completed"]);
  const normalized = normalizeArtifact(jobId, artifact);
  const attempt = currentAttempt(jobId, leaseId);
  const artifactId = createArtifact(jobId, {
    ...normalized,
    attemptId: attempt?.attempt_id,
    workerId,
    leaseId,
    state: "finalized",
    finalizedAt: nowIso(),
    storageRef: normalized.storageRef || `compute/${jobId}/${generateId("artifact")}`,
    metadata: { ...normalized.metadata, workerId, verified: true, inline: true },
  });
  const finalized = getArtifact(artifactId);
  if (platformKernel && executionId) {
    try {
      platformKernel.registerArtifact({
        type: finalized.artifactType || "compute-result",
        name: finalized.name || artifactId,
        execution_id: executionId,
        producer: workerId,
        storage_ref: finalized.storageRef || `compute/${jobId}/${artifactId}`,
        content_type: finalized.contentType || "text/plain",
        byte_size: finalized.sizeBytes || 0,
        content_hash: finalized.contentHash,
        sensitivity: finalized.sensitivity || "normal",
        verification: { hash_verified: true },
        source: "compute",
      });
    } catch {}
  }
  return artifactId;
}

function normalizeArtifact(jobId, artifact) {
  const content = artifact.content !== undefined ? Buffer.from(String(artifact.content), "utf8") : null;
  const explicitSize = artifact.sizeBytes || artifact.size_bytes;
  const sizeBytes = explicitSize !== undefined ? Number(explicitSize) : (content ? content.length : 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > 10 * 1024 * 1024) throw new JobError("Artifact size invalid or too large", "ARTIFACT_SIZE", { jobId });
  const computedHash = content ? crypto.createHash("sha256").update(content).digest("hex") : null;
  const providedHash = artifact.contentHash || artifact.content_hash;
  const contentHash = providedHash || computedHash;
  if (content && providedHash && providedHash !== computedHash) throw new JobError("Artifact hash mismatch", "ARTIFACT_HASH_MISMATCH", { jobId });
  return {
    artifactType: String(artifact.artifactType || artifact.type || "result").slice(0, 80),
    name: String(artifact.name || "artifact.txt").replace(/[\0\r\n]/g, " ").slice(0, 160),
    storagePath: artifact.storagePath || artifact.storage_path || null,
    storageRef: artifact.storageRef || artifact.storage_ref || null,
    contentType: String(artifact.contentType || artifact.content_type || "text/plain").slice(0, 120),
    contentHash,
    sizeBytes,
    sensitivity: String(artifact.sensitivity || "private").slice(0, 40),
    retentionDays: artifact.retentionDays || artifact.retention_days,
    metadata: artifact.metadata || {},
  };
}

function currentAttempt(jobId, leaseId) {
  return dbStore.getDb().prepare("SELECT attempt_id FROM compute_job_attempts WHERE job_id = ? AND lease_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId, leaseId);
}

function uploadArtifact(jobId, workerId, leaseId, artifact = {}) {
  ensureSchema();
  assertLeaseOwner(jobId, workerId, leaseId, ["leased", "starting", "running"]);
  const normalized = normalizeArtifact(jobId, artifact);
  const attempt = currentAttempt(jobId, leaseId);
  const artifactId = createArtifact(jobId, {
    ...normalized,
    attemptId: attempt?.attempt_id,
    workerId,
    leaseId,
    state: "uploaded",
    storageRef: normalized.storageRef || `compute/${jobId}/uploads/${generateId("upload")}`,
    metadata: { ...normalized.metadata, workerId, verified: false },
  });
  emitComputeEvent("compute.artifact_uploaded", getJob(jobId), { worker_id: workerId, lease_id: leaseId, artifact_id: artifactId });
  return getArtifact(artifactId);
}

function getArtifact(artifactId) {
  ensureSchema();
  return rowToArtifact(dbStore.getDb().prepare("SELECT * FROM compute_artifacts WHERE artifact_id = ?").get(artifactId));
}

function finalizeArtifact(jobId, workerId, leaseId, artifactId, { contentHash, content_hash, sizeBytes, size_bytes } = {}) {
  ensureSchema();
  assertLeaseOwner(jobId, workerId, leaseId, ["leased", "starting", "running"]);
  const db = dbStore.getDb();
  const artifact = rowToArtifact(db.prepare("SELECT * FROM compute_artifacts WHERE artifact_id = ? AND job_id = ?").get(artifactId, jobId));
  if (!artifact) throw new JobError("Artifact not found", "ARTIFACT_NOT_FOUND", { jobId, artifactId });
  if (artifact.workerId !== workerId || artifact.leaseId !== leaseId) throw new LeaseExpiredError(jobId, leaseId);
  if (artifact.state === "finalized") return artifact;
  const expectedHash = contentHash || content_hash;
  const expectedSize = sizeBytes || size_bytes;
  if (expectedHash && artifact.contentHash && expectedHash !== artifact.contentHash) throw new JobError("Artifact hash mismatch", "ARTIFACT_HASH_MISMATCH", { jobId, artifactId });
  if (expectedSize !== undefined && Number(expectedSize) !== Number(artifact.sizeBytes || 0)) throw new JobError("Artifact size mismatch", "ARTIFACT_SIZE_MISMATCH", { jobId, artifactId });
  const now = nowIso();
  const updated = db.prepare("UPDATE compute_artifacts SET state = 'finalized', finalized_at = ?, metadata_json = ? WHERE artifact_id = ? AND job_id = ? AND state = 'uploaded'")
    .run(now, json({ ...artifact.metadata, verified: true, finalizedBy: workerId }), artifactId, jobId);
  if (updated.changes !== 1) return getArtifact(artifactId);
  const finalized = getArtifact(artifactId);
  emitComputeEvent("compute.artifact_finalized", getJob(jobId), { worker_id: workerId, lease_id: leaseId, artifact_id: artifactId });
  return finalized;
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

function createArtifact(jobId, { attemptId, workerId, leaseId, artifactType, name, storagePath, storageRef, contentType, contentHash, sizeBytes, state = "finalized", finalizedAt, sensitivity = "private", retentionDays, metadata = {} }) {
  ensureSchema();
  const db = dbStore.getDb();
  const artifactId = generateId("art");
  db.prepare(`
    INSERT INTO compute_artifacts (
      artifact_id, job_id, attempt_id, artifact_type, name, storage_path, storage_ref,
      content_type, content_hash, size_bytes, worker_id, lease_id, state, finalized_at, sensitivity, retention_days, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(artifactId, jobId, attemptId || null, artifactType, name, storagePath || null, storageRef || null, contentType || null, contentHash || null, sizeBytes || 0, workerId || null, leaseId || null, state, finalizedAt || (state === "finalized" ? nowIso() : null), sensitivity, retentionDays || null, json(metadata));
  return artifactId;
}

function listArtifacts(jobId) {
  ensureSchema();
  const db = dbStore.getDb();
  return db.prepare("SELECT * FROM compute_artifacts WHERE job_id = ? ORDER BY created_at").all(jobId).map(rowToArtifact);
}

function listAttempts(jobId) {
  ensureSchema();
  const db = dbStore.getDb();
  return db.prepare("SELECT * FROM compute_job_attempts WHERE job_id = ? ORDER BY attempt_number, created_at").all(jobId).map(rowToAttempt);
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
  const activeLeases = db.prepare("SELECT COUNT(*) as count FROM compute_jobs WHERE lease_id IS NOT NULL AND status IN ('leased','starting','running')").get();
  const attempts = db.prepare("SELECT COUNT(*) as count FROM compute_job_attempts").get();
  const artifacts = db.prepare("SELECT state, COUNT(*) as count FROM compute_artifacts GROUP BY state").all();
  return {
    total: total?.count || 0,
    activeLeases: activeLeases?.count || 0,
    attempts: attempts?.count || 0,
    artifacts: Object.fromEntries(artifacts.map(a => [a.state || "unknown", a.count])),
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
  claimNextJob,
  workerEligibleToClaim,
  renewLease,
  checkLeaseExpiration,
  recoverExpiredLeases,
  startLeasedJob,
  updateProgress,
  completeJob,
  failJob,
  cancelJob,
  getCancellationStatus,
  acknowledgeCancellation,
  retryJob,
  uploadArtifact,
  finalizeArtifact,
  getArtifact,
  createAttempt,
  updateAttempt,
  createArtifact,
  listArtifacts,
  listAttempts,
  getJobStats,
  rowToJob,
  workerCompatibility,
  workerCanRunJob,
};
