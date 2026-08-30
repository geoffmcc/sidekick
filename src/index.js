require("./env");
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { timingSafeCompare } = require("./crypto-utils");
const { readSecret } = require("./core/runtime-secrets");
// The v2 server package intentionally no longer serves the deprecated HTTP+SSE
// transport. The extracted legacy route module keeps Sidekick's established
// compatibility endpoint on the official frozen migration package.
const { DATA_DIR, syncToolRegistry } = require("./tools");
const dbStore = require("./db");
const authentication = require("./core/authentication");
const packageJson = require("../package.json");
const { createMcpServer } = require("./mcp/server");
const { createSessionManager } = require("./mcp/session-manager");
const { registerStreamableHttpRoutes } = require("./mcp/streamable-http");
const { registerLegacySseRoutes } = require("./mcp/legacy-sse");
const executionNode = require("./node/manager");
const executionNodeWorkspace = require("./node/workspace");
executionNode.ensureSchema();
const executionNodeRecoveryTimer = setInterval(() => {
  try { executionNode.recoverExpired(); } catch {}
}, 30000);
if (executionNodeRecoveryTimer.unref) executionNodeRecoveryTimer.unref();

const APP_VERSION = packageJson.version || "0.0.0";
const NODE_REQUIREMENT = packageJson.engines?.node || "unspecified";

const IS_LOCAL = process.env.SIDEKICK_LOCAL === "1";
const API_KEY = IS_LOCAL ? "" : readSecret("SIDEKICK_API_KEY", { required: true });
if (!IS_LOCAL && (!API_KEY || API_KEY === "sk-sidekick-local-dev" || API_KEY === "sk-your-key-here")) {
  throw new Error("SIDEKICK_API_KEY must be set to a non-placeholder value");
}
const PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const ALLOWED_IPS = (process.env.SIDEKICK_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
const PRIVACY_POLICY_PATH = path.join(__dirname, "..", "docs", "privacy.md");

function ipInRange(ip, cidr) {
  if (!cidr.includes("/")) return ip === cidr;
  const [rangeIp, bits] = cidr.split("/");
  const maskBits = parseInt(bits, 10);
  if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) return false;
  const mask = ~(2 ** (32 - maskBits) - 1) >>> 0;
  const ipNum = ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  const rangeNum = rangeIp.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function logDebug(context, data) {
  const ts = new Date().toISOString();
  const prefix = `[MCP-DEBUG ${ts}]`;
  if (typeof data === 'string') {
    console.log(`${prefix} ${context}: ${data}`);
  } else {
    console.log(`${prefix} ${context}:`, JSON.stringify(data, null, 2));
  }
}

// Local stdio uses the same MCP registration below but never starts this
// HTTP listener. The CLI redirects console.log to stderr before loading us.

const sessionManager = createSessionManager({ createMcpServer, logDebug });
let browserSubsystem = null;
let eventDrainer = null;
let httpServer = null;
let builtinModules = null;
let shuttingDown = null;
const startupFailures = {};
const serverStartTime = Date.now();

// --- Express app ---

const app = express();

function getBearerToken(req) {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
  }
  return null;
}

if (ALLOWED_IPS.length) {
  app.use((req, res, next) => {
    const ip = req.ip === "::ffff:127.0.0.1" ? "127.0.0.1" : req.ip;
    if (ip === "127.0.0.1" || ip === "::1" || ALLOWED_IPS.some(entry => ipInRange(ip, entry))) {
      return next();
    }
    return res.status(403).json({ error: "Forbidden" });
  });
}

app.get("/health", (req, res) => {
  const uptimeMs = Date.now() - serverStartTime;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

  const includeDetails = timingSafeCompare(getBearerToken(req), API_KEY);

  const payload = {
    // Keep this endpoint live even when a critical startup dependency failed;
    // readiness below carries the traffic-serving decision.
    status: Object.keys(startupFailures).length ? "degraded" : "healthy",
    uptime: uptimeSeconds,
    uptimeHuman: uptimeStr,
    ...sessionManager.getHealthSnapshot(),
    version: APP_VERSION,
    runtime: {
      node: process.version,
      requiredNode: NODE_REQUIREMENT
    },
    timestamp: new Date().toISOString()
  };
  payload.readiness = {
    ready: Object.keys(startupFailures).length === 0,
    failures: { ...startupFailures },
  };

  if (includeDetails) {
    payload.sessionDetails = sessionManager.getHealthSnapshot().sessionDetails;
  }

  res.json(payload);
});

// Public policy URL for directory listings. It intentionally sits before the
// authenticated API middleware and serves only the repository policy document.
app.get("/privacy", (req, res) => {
  res.type("text/markdown").send(fs.readFileSync(PRIVACY_POLICY_PATH, "utf8"));
});

app.get("/readiness", (req, res) => {
  const ready = Object.keys(startupFailures).length === 0;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    ready,
    failures: { ...startupFailures },
  });
});

app.use((req, res, next) => {
  if (isComputeAuthBypassPath(req.path)) return next();
  const token = getBearerToken(req);
  const credential = authentication.authenticateCredential(token);
  if (credential) {
    req.authIdentity = {
      principal_id: credential.principal_id,
      principal_type: credential.principal_type,
      scopes: credential.scopes,
      credential_id: credential.credential_id,
      authentication_method: "scoped_credential",
    };
    return next();
  }
  if (timingSafeCompare(token, API_KEY)) {
    // Compatibility only: this legacy installation-wide key remains visible
    // as legacy authentication until scoped credentials replace its clients.
    req.authIdentity = { authentication_method: "legacy_api_key", scopes: ["legacy"] };
    return next();
  }
  if (!token) {
    return res.status(401).json({ error: "Authentication required", code: "unauthenticated" });
  }
  if (!credential) {
    return res.status(401).json({ error: "Unauthorized" });
  }
});

app.use(express.json({ limit: "1mb" }));

registerLegacySseRoutes({ app, sessionManager, createMcpServer });
registerStreamableHttpRoutes({ app, sessionManager, createMcpServer, logDebug });

// Run pending migrations automatically on startup
try {
  const migrationResult = dbStore.runPendingMigrations();
  if (migrationResult.applied > 0) {
    console.log(`[Migration] Applied ${migrationResult.applied} migration(s):`, migrationResult.migrations.map(m => m.file).join(', '));
  }
} catch (error) {
  console.error('[Migration] Error running migrations:', error.message);
  process.exitCode = 1;
  throw error;
}

// Repair the knowledge FTS index on every server boot. This also creates the
// index on installations that predate FTS-backed knowledge search.
try {
  const knowledgeFts = dbStore.rebuildKnowledgeFts();
  if (knowledgeFts.success) {
    console.log(`[Knowledge] Rebuilt FTS index (${knowledgeFts.count} rows)`);
  }
} catch (error) {
  console.error('[Knowledge] FTS index repair failed:', error.message);
}

// Converge the approval-continuation schema after migrations. Migration 025
// deliberately leaves the additive `approval_execution_recovery_events` columns
// to this idempotent owner, because migrations run only in this process while
// the ensure runs in every process that touches approvals and start order is
// not guaranteed (see the comment in 025_approval_continuation.sql). Calling it
// here means a deployment converges on startup rather than on first use.
try {
  require('./approvals/store').ensureApprovalContinuationSchema();
} catch (error) {
  console.error('[Migration] Approval continuation schema ensure failed:', error.message);
  process.exitCode = 1;
  throw error;
}

// Provision builtin platform modules (register on first boot, restore
// persisted enabled modules) BEFORE the registry sync and MCP server
// creation so module tools are live for the catalog and tool listing.
try {
  builtinModules = require("./modules/builtin-modules");
  const provision = builtinModules.provisionBuiltinModules();
  if (provision.provisioned.length || provision.skipped.length || provision.errors.length) {
    console.log(`[Modules] Provisioned: ${JSON.stringify(provision.provisioned)}; skipped: ${JSON.stringify(provision.skipped)}; errors: ${provision.errors.length}`);
  }
  builtinModules.startModuleHealthChecks();
  builtinModules.startModuleReconciliation();
} catch (error) {
  console.error("[Modules] Builtin module provisioning failed:", error.message);
}

// Sync tool registry from code to database on startup
syncToolRegistry();

// Initialize compute subsystem (providers, models, routing, health monitoring)
try {
  const compute = require("./compute");
  compute.initialize();
  console.log("[Compute] Subsystem initialized");
} catch (e) {
  console.error("[Compute] Init failed (non-fatal):", e.message);
  startupFailures.compute = String(e.message || e).slice(0, 300);
}

// Initialize the browser subsystem: directories, orphaned-Chromium reaping,
// and the idle-session reaper. Launches nothing; the browser starts on first
// use and a missing runtime is a health state, not a startup failure.
try {
  browserSubsystem = require("./browser");
  const browserInit = browserSubsystem.initialize();
  if (browserInit.initialized) {
    console.log(`[Browser] Subsystem initialized (orphans reaped: ${browserInit.orphans_reaped})`);
  } else {
    console.log(`[Browser] Subsystem not initialized: ${browserInit.reason}`);
  }
} catch (e) {
  console.error("[Browser] Init failed (non-fatal):", e.message);
  startupFailures.browser = String(e.message || e).slice(0, 300);
}

// Register managed connectors (GitHub) in the platform connector authority so
// the github tool routes through a governed connector rather than reaching the
// API directly. Idempotent and non-fatal.
try {
  require("./connectors/bootstrap").bootstrapConnectors();
  console.log("[Connectors] Bootstrap complete");
} catch (e) {
  console.error("[Connectors] Bootstrap failed (non-fatal):", e.message);
}

// Start the platform event delivery drainer. Without it the delivery tables are
// a queue with no consumer: events fan out into `pending` rows that nothing
// ever claims. Runs in the MCP process only — a second drainer would be safe
// (claims are atomic) but pointless. Opt out with SIDEKICK_DISABLE_EVENT_DRAINER=1.
if (process.env.SIDEKICK_DISABLE_EVENT_DRAINER === "1") {
  console.log("[Events] Drainer disabled by SIDEKICK_DISABLE_EVENT_DRAINER");
} else {
  try {
    eventDrainer = require("./platform/event-drainer");
    const consumers = eventDrainer.registerBuiltinConsumers();
    const started = eventDrainer.startDrainer();
    console.log(`[Events] Drainer started (interval ${started.intervalMs}ms); consumers: ${JSON.stringify(consumers.registered)}`);
    if (consumers.errors.length) console.error("[Events] Consumer registration errors:", JSON.stringify(consumers.errors));
  } catch (e) {
    console.error("[Events] Drainer start failed (non-fatal):", e.message);
  }
}

const compute = require("./compute");
let platformKernelForComputeAudit = null;
try { platformKernelForComputeAudit = require("./platform/kernel"); } catch {}
const computeEnrollmentRateLimit = new Map();

function sendComputeError(res, error, status = 400) {
  const code = error.code || "COMPUTE_ERROR";
  const message = String(error.message || "Compute error").replace(/(wksec_|enroll_)[A-Za-z0-9_-]+/g, "[REDACTED]");
  res.status(status).json({ ok: false, error: message, code });
}

function auditComputeEvent(eventType, { actor = "compute", subjectType, subjectId, payload = {}, severity = "info" } = {}) {
  if (!platformKernelForComputeAudit) return;
  try {
    platformKernelForComputeAudit.appendEvent({
      event_type: eventType,
      source: "compute",
      actor_id: actor,
      subject_type: subjectType,
      subject_id: subjectId,
      severity,
      payload,
      sensitivity: "normal",
      // These payloads carry caller-supplied fields (reason, display_name), so
      // this publisher cannot honestly claim to have redacted them. Declaring
      // "none" makes the delivery path redact before a subscriber sees it.
      redaction_state: "none",
      correlation_id: subjectId || undefined,
    });
  } catch {}
}

function enforceEnrollmentRateLimit(req, res, next) {
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const current = computeEnrollmentRateLimit.get(key) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= 20) return res.status(429).json({ ok: false, error: "enrollment rate limit exceeded" });
  recent.push(now);
  computeEnrollmentRateLimit.set(key, recent);
  next();
}

function requireComputeJsonContent(req, res, next) {
  if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ ok: false, error: "compute protocol requires application/json" });
  }
  next();
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const key = req.headers["x-api-key"] || bearer;
  if (!key || !timingSafeCompare(String(key), API_KEY)) return res.status(401).json({ ok: false, error: "admin authentication required" });
  next();
}

function parseWorkerAuth(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const value = auth.slice(7);
    const idx = value.indexOf(":");
    if (idx > 0) return { workerId: value.slice(0, idx), credential: value.slice(idx + 1) };
  }
  return {
    workerId: req.headers["x-sidekick-worker-id"],
    credential: req.headers["x-sidekick-worker-secret"],
  };
}

function requireWorker(req, res, next) {
  const { workerId, credential } = parseWorkerAuth(req);
  const worker = compute.workerManager.authenticateWorker(workerId, credential);
  if (!worker) return res.status(401).json({ ok: false, error: "worker authentication required" });
  req.computeWorker = worker;
  next();
}

function isComputeAuthBypassPath(pathname) {
  if (pathname.startsWith("/execution-node/")) return true;
  if (pathname === "/compute/enrollment/exchange" || pathname === "/compute/enroll") return true;
  if (pathname.startsWith("/compute/worker/")) return true;
  const legacyWorkerPaths = [
    "/compute/heartbeat",
    "/compute/capabilities",
    "/compute/credentials/rotate",
    "/compute/jobs/claim",
  ];
  if (legacyWorkerPaths.includes(pathname)) return true;
  return /^\/compute\/jobs\/[^/]+\/(start|renew|progress|complete|fail)$/.test(pathname)
    || /^\/compute\/jobs\/[^/]+\/cancellation(\/ack)?$/.test(pathname)
    || /^\/compute\/jobs\/[^/]+\/artifacts\/(upload|[^/]+\/finalize)$/.test(pathname);
}

function createEnrollmentTokenHandler(req, res) {
  try {
    const body = req.body || {};
    const token = compute.workerManager.createEnrollmentToken({
      displayName: body.displayName || body.display_name,
      trustLevel: body.trustLevel || body.trust_level || "trusted",
      allowedDataClassifications: body.allowedDataClassifications || body.allowed_data_classifications || ["public", "internal", "private"],
      maxConcurrentJobs: body.maxConcurrentJobs || body.max_concurrent_jobs || 2,
      expiresInMs: body.expiresInMs || body.expires_in_ms || 3600000,
      createdBy: "admin-http",
      reEnrollmentOf: body.reEnrollmentOf || body.re_enrollment_of || null,
    });
    auditComputeEvent("compute.enrollment_token.created", { actor: "admin-http", subjectType: "compute_enrollment_token", subjectId: token.tokenId, payload: { display_name: body.displayName || body.display_name || null, re_enrollment_of: token.reEnrollmentOf || null } });
    res.json({ ok: true, ...token, message: "Token created. The token value is returned only once." });
  } catch (e) { sendComputeError(res, e, 400); }
}

function enrollWorkerHandler(req, res) {
  try {
    const { token, nodeId, displayName, platform, architecture, cpuInfo, memoryBytes, accelerators, providers, executors, workerVersion, publicKey, protocolVersion } = req.body || {};
    if (!token || !nodeId || !displayName || !platform) {
      return res.status(400).json({ error: "token, nodeId, displayName, and platform are required" });
    }
    if (protocolVersion && String(protocolVersion) !== "1") return res.status(426).json({ ok: false, error: "unsupported worker protocol version", supported: ["1"] });
    const enrolled = compute.workerManager.enrollWorker({
      nodeId, displayName, platform, architecture, cpuInfo, memoryBytes,
      accelerators, providers, executors,
      modelInventory: req.body?.modelInventory || req.body?.model_inventory,
      limits: req.body?.limits,
      health: req.body?.health || req.body?.backendHealth || req.body?.backend_health,
      workerVersion, publicKey, enrollmentToken: token, protocolVersion,
    });
    auditComputeEvent(enrolled.reEnrolled ? "compute.worker.re_enrolled" : "compute.worker.enrolled", { actor: enrolled.worker.workerId, subjectType: "compute_worker", subjectId: enrolled.worker.workerId, payload: { node_id: nodeId, protocol_version: protocolVersion || "1", re_enrolled: !!enrolled.reEnrolled, replaced_worker_id: enrolled.replacedWorkerId || null }, severity: enrolled.reEnrolled ? "warning" : "info" });
    res.json({ ok: true, worker: enrolled.worker, credential: enrolled.credential, credentialType: "worker-bearer-v1", reEnrolled: !!enrolled.reEnrolled });
  } catch (e) {
    sendComputeError(res, e, 400);
  }
}

function heartbeatHandler(req, res) {
  try {
    const { utilization, currentJobs, telemetry, providers, executors, accelerators, workerVersion } = req.body || {};
    const modelInventory = req.body?.modelInventory || req.body?.model_inventory;
    const limits = req.body?.limits;
    const health = req.body?.health || req.body?.backendHealth || req.body?.backend_health;
    if (providers || executors || accelerators || workerVersion || modelInventory || limits || health) {
      compute.workerManager.updateWorker(req.computeWorker.workerId, { providers, executors, accelerators, workerVersion, modelInventory, limits, health });
    }
    const worker = compute.workerManager.heartbeat(req.computeWorker.workerId, { utilization, currentJobs, telemetry });
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    res.json({ ok: true, worker });
  } catch (e) {
    sendComputeError(res, e, 400);
  }
}

function disconnectHandler(req, res) {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : "graceful";
    const worker = compute.workerManager.disconnectWorker(req.computeWorker.workerId, reason);
    if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.disconnected", { actor: req.computeWorker.workerId, subjectType: "compute_worker", subjectId: req.computeWorker.workerId, payload: { reason } });
    res.json({ ok: true, worker });
  } catch (e) {
    sendComputeError(res, e, 400);
  }
}

function capabilitiesHandler(req, res) {
  try {
    const { providers, executors, accelerators, maxConcurrentJobs, workerVersion } = req.body || {};
    const worker = compute.workerManager.updateWorker(req.computeWorker.workerId, {
      providers,
      executors,
      accelerators,
      maxConcurrentJobs,
      workerVersion,
      modelInventory: req.body?.modelInventory || req.body?.model_inventory,
      limits: req.body?.limits,
      health: req.body?.health || req.body?.backendHealth || req.body?.backend_health,
    });
    res.json({ ok: true, worker });
  } catch (e) { sendComputeError(res, e, 400); }
}

function rotateCredentialHandler(req, res) {
  try {
    const result = compute.workerManager.rotateCredential(req.computeWorker.workerId);
    if (!result) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.credential_rotated", { actor: req.computeWorker.workerId, subjectType: "compute_worker", subjectId: req.computeWorker.workerId });
    res.json({ ok: true, worker: result.worker, credential: result.credential, credentialType: "worker-bearer-v1" });
  } catch (e) { sendComputeError(res, e, 400); }
}

function createJobHandler(req, res) {
  try {
    const body = req.body || {};
    if (!body.jobType && !body.job_type) return res.status(400).json({ ok: false, error: "jobType is required" });
    const job = compute.jobManager.createJob({
      jobType: body.jobType || body.job_type,
      capability: body.capability || body.jobType || body.job_type,
      source: "http",
      project: body.project,
      taskId: body.taskId || body.task_id,
      sessionId: body.sessionId || body.session_id,
      requestingActor: "admin",
      dataClassification: body.dataClassification || body.data_classification || "private",
      protocolVersion: body.protocolVersion || body.protocol_version || "1",
      capabilityRequirements: body.capabilityRequirements || body.capability_requirements || {},
      routingPreferences: body.routingPreferences || body.routing_preferences || {},
      retryPolicy: body.retryPolicy || body.retry_policy || {},
      resourceRequirements: body.resourceRequirements || body.resource_requirements || {},
      artifactExpectations: body.artifactExpectations || body.artifact_expectations || [],
      outputLimits: body.outputLimits || body.output_limits || {},
      requestPayload: body.requestPayload || body.request_payload || {},
      priority: body.priority,
      expiresAt: body.expiresAt || body.expires_at,
      maxAttempts: body.maxAttempts || body.max_attempts || 3,
      timeoutMs: body.timeoutMs || body.timeout_ms,
      idempotencyKey: body.idempotencyKey || body.idempotency_key,
    });
    res.json({ ok: true, job });
  } catch (e) { sendComputeError(res, e, 400); }
}

function listJobsHandler(req, res) {
  try {
    const jobs = compute.jobManager.listJobs({
      status: req.query?.status,
      jobType: req.query?.jobType || req.query?.job_type,
      project: req.query?.project,
      providerId: req.query?.providerId || req.query?.provider_id,
      workerId: req.query?.workerId || req.query?.worker_id,
      capability: req.query?.capability,
      limit: req.query?.limit ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : 50,
    });
    res.json({ ok: true, jobs, stats: compute.jobManager.getJobStats() });
  } catch (e) { sendComputeError(res, e, 400); }
}

function getJobHandler(req, res) {
  const job = compute.jobManager.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "job not found" });
  res.json({ ok: true, job, attempts: compute.jobManager.listAttempts(req.params.jobId), artifacts: compute.jobManager.listArtifacts(req.params.jobId) });
}

function cancelJobHandler(req, res) {
  try { const job = compute.jobManager.cancelJob(req.params.jobId, { actor: "admin", reason: req.body?.reason || "cancelled" }); auditComputeEvent("compute.job.cancelled", { actor: "admin", subjectType: "compute_job", subjectId: req.params.jobId, payload: { reason: req.body?.reason || "cancelled" }, severity: "warning" }); res.json({ ok: true, job }); }
  catch (e) { sendComputeError(res, e, 400); }
}

function claimJobHandler(req, res) {
  try {
    const result = compute.jobManager.claimNextJob(req.computeWorker, { leaseDurationMs: req.body?.leaseDurationMs || req.body?.lease_duration_ms || 300000 });
    if (result && result.ineligible) return res.json({ ok: true, claimed: false, reason: result.ineligible });
    res.json({ ok: true, claimed: !!result, ...(result || {}) });
  } catch (e) { sendComputeError(res, e, 400); }
}

function startJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.startLeasedJob(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function renewJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.renewLease(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body?.leaseDurationMs || req.body?.lease_duration_ms || 300000) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function progressJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.updateProgress(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body || {}) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function cancellationStatusHandler(req, res) {
  try { res.json({ ok: true, cancellation: compute.jobManager.getCancellationStatus(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id || req.query?.leaseId || req.query?.lease_id) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function cancellationAckHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.acknowledgeCancellation(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function completeJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.completeJob(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body || {}) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function uploadArtifactHandler(req, res) {
  try {
    const artifact = compute.jobManager.uploadArtifact(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body || {});
    res.json({ ok: true, artifact });
  } catch (e) { sendComputeError(res, e, 409); }
}

function finalizeArtifactHandler(req, res) {
  try {
    const artifact = compute.jobManager.finalizeArtifact(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.params.artifactId, req.body || {});
    res.json({ ok: true, artifact });
  } catch (e) { sendComputeError(res, e, 409); }
}

function failJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.failJob(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body || {}) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function recoverJobsHandler(req, res) {
  try { res.json({ ok: true, recovered: compute.jobManager.recoverExpiredLeases() }); }
  catch (e) { sendComputeError(res, e, 500); }
}

function retryJobHandler(req, res) {
  try { const job = compute.jobManager.retryJob(req.params.jobId, { actor: "admin", reason: req.body?.reason || "retry_requested" }); auditComputeEvent("compute.job.retry_requested", { actor: "admin", subjectType: "compute_job", subjectId: req.params.jobId, payload: { reason: req.body?.reason || "retry_requested" } }); res.json({ ok: true, job }); }
  catch (e) { sendComputeError(res, e, 400); }
}

function listWorkersHandler(req, res) {
  try { res.json({ ok: true, workers: compute.workerManager.listWorkers(req.query || {}) }); }
  catch (e) { sendComputeError(res, e, 400); }
}

function getWorkerHandler(req, res) {
  const worker = compute.workerManager.getWorker(req.params.workerId);
  if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
  res.json({ ok: true, worker });
}

function disableWorkerHandler(req, res) {
  try {
    const worker = compute.workerManager.updateWorker(req.params.workerId, { adminState: "maintenance" });
    if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.disabled", { actor: "admin", subjectType: "compute_worker", subjectId: req.params.workerId, payload: { reason: req.body?.reason || null }, severity: "warning" });
    res.json({ ok: true, worker });
  } catch (e) { sendComputeError(res, e, 400); }
}

function enableWorkerHandler(req, res) {
  try {
    const worker = compute.workerManager.updateWorker(req.params.workerId, { adminState: "enabled" });
    if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.enabled", { actor: "admin", subjectType: "compute_worker", subjectId: req.params.workerId, payload: { reason: req.body?.reason || null } });
    res.json({ ok: true, worker });
  } catch (e) { sendComputeError(res, e, 400); }
}

function revokeWorkerHandler(req, res) {
  try {
    const worker = compute.workerManager.revokeWorker(req.params.workerId, req.body?.reason || "admin_revoked");
    if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.revoked", { actor: "admin", subjectType: "compute_worker", subjectId: req.params.workerId, payload: { reason: req.body?.reason || "admin_revoked" }, severity: "warning" });
    res.json({ ok: true, worker });
  } catch (e) { sendComputeError(res, e, 400); }
}

function adminRotateWorkerCredentialHandler(req, res) {
  try {
    const result = compute.workerManager.rotateCredential(req.params.workerId);
    if (!result) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.credential_rotated", { actor: "admin", subjectType: "compute_worker", subjectId: req.params.workerId });
    res.json({ ok: true, worker: result.worker, credential: result.credential, credentialType: "worker-bearer-v1" });
  } catch (e) { sendComputeError(res, e, 400); }
}

function computeHealthHandler(req, res) {
  try {
    res.json({ ok: true, overview: compute.overview() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Canonical compute route groups. Enrollment exchange is public but validates a one-time token;
// worker routes require scoped worker credentials; admin routes require the Sidekick API key.
app.use("/compute", requireComputeJsonContent);
const computeEnrollmentRouter = express.Router();
computeEnrollmentRouter.post("/tokens", express.json({ limit: "16kb" }), requireAdmin, createEnrollmentTokenHandler);
computeEnrollmentRouter.post("/exchange", express.json({ limit: "64kb" }), enforceEnrollmentRateLimit, enrollWorkerHandler);
app.use("/compute/enrollment", computeEnrollmentRouter);

const computeWorkerRouter = express.Router();
computeWorkerRouter.use(requireWorker);
computeWorkerRouter.post("/heartbeat", express.json({ limit: "32kb" }), heartbeatHandler);
computeWorkerRouter.post("/disconnect", express.json({ limit: "8kb" }), disconnectHandler);
computeWorkerRouter.post("/capabilities", express.json({ limit: "64kb" }), capabilitiesHandler);
computeWorkerRouter.post("/credentials/rotate", express.json({ limit: "8kb" }), rotateCredentialHandler);
computeWorkerRouter.post("/jobs/claim", express.json({ limit: "16kb" }), claimJobHandler);
computeWorkerRouter.post("/jobs/:jobId/start", express.json({ limit: "16kb" }), startJobHandler);
computeWorkerRouter.post("/jobs/:jobId/renew", express.json({ limit: "16kb" }), renewJobHandler);
computeWorkerRouter.post("/jobs/:jobId/progress", express.json({ limit: "16kb" }), progressJobHandler);
computeWorkerRouter.post("/jobs/:jobId/cancellation", express.json({ limit: "16kb" }), cancellationStatusHandler);
computeWorkerRouter.post("/jobs/:jobId/cancellation/ack", express.json({ limit: "16kb" }), cancellationAckHandler);
computeWorkerRouter.post("/jobs/:jobId/artifacts/upload", express.json({ limit: "512kb" }), uploadArtifactHandler);
computeWorkerRouter.post("/jobs/:jobId/artifacts/:artifactId/finalize", express.json({ limit: "64kb" }), finalizeArtifactHandler);
computeWorkerRouter.post("/jobs/:jobId/complete", express.json({ limit: "512kb" }), completeJobHandler);
computeWorkerRouter.post("/jobs/:jobId/fail", express.json({ limit: "64kb" }), failJobHandler);
app.use("/compute/worker", computeWorkerRouter);

const computeAdminRouter = express.Router();
computeAdminRouter.use(requireAdmin);
computeAdminRouter.get("/workers", listWorkersHandler);
computeAdminRouter.get("/workers/:workerId", getWorkerHandler);
computeAdminRouter.post("/workers/:workerId/disable", express.json({ limit: "8kb" }), disableWorkerHandler);
computeAdminRouter.post("/workers/:workerId/enable", express.json({ limit: "8kb" }), enableWorkerHandler);
computeAdminRouter.post("/workers/:workerId/revoke", express.json({ limit: "8kb" }), revokeWorkerHandler);
computeAdminRouter.post("/workers/:workerId/credentials/rotate", express.json({ limit: "8kb" }), adminRotateWorkerCredentialHandler);
computeAdminRouter.post("/jobs", express.json({ limit: "256kb" }), createJobHandler);
computeAdminRouter.get("/jobs", listJobsHandler);
computeAdminRouter.get("/jobs/:jobId", getJobHandler);
computeAdminRouter.post("/jobs/:jobId/cancel", express.json({ limit: "8kb" }), cancelJobHandler);
computeAdminRouter.post("/jobs/:jobId/retry", express.json({ limit: "8kb" }), retryJobHandler);
computeAdminRouter.post("/recover", express.json({ limit: "8kb" }), recoverJobsHandler);
computeAdminRouter.get("/health", computeHealthHandler);
app.use("/compute/admin", computeAdminRouter);

// General execution-node protocol. It deliberately has its own job table and
// poll surface: compute inference jobs and canonical tool calls have different
// contracts, receipts, and ambiguity rules, while enrollment/authentication and
// heartbeat identity remain the existing worker authority.
function requireExecutionNode(req, res, next) {
  requireWorker(req, res, () => {
    const node = executionNode.get(req.computeWorker.workerId);
    if (!node) return res.status(403).json({ ok: false, error: "execution node is not registered" });
    req.executionNode = node;
    next();
  });
}

function enrollExecutionNodeHandler(req, res) {
  try {
    const body = req.body || {};
    if (!body.token || !body.nodeId || !body.displayName || !body.platform) return res.status(400).json({ ok: false, error: "token, nodeId, displayName, and platform are required" });
    if (String(body.protocolVersion || "1") !== "1") return res.status(426).json({ ok: false, error: "unsupported execution-node protocol", supported: ["1"] });
    const enrolled = compute.workerManager.enrollWorker({
      nodeId: body.nodeId, displayName: body.displayName, platform: body.platform, architecture: body.architecture,
      cpuInfo: body.cpuInfo, memoryBytes: body.memoryBytes, accelerators: [], providers: [], executors: [],
      modelInventory: [], limits: body.limits || {}, health: body.health || {}, workerVersion: body.nodeVersion,
      publicKey: body.publicKey, enrollmentToken: body.token, protocolVersion: "1",
    });
    const node = executionNode.register(enrolled.worker.workerId, {
      protocolVersion: "1", descriptorSetHash: body.descriptorSetHash,
      capabilities: body.capabilities || {}, workspaces: [], networkScopes: [], limits: body.limits || {},
    });
    res.json({ ok: true, node, worker: enrolled.worker, credential: enrolled.credential, credentialType: "worker-bearer-v1" });
  } catch (e) { sendComputeError(res, e, 400); }
}

function nodeHeartbeatHandler(req, res) {
  try {
    const body = req.body || {};
    const node = executionNode.register(req.computeWorker.workerId, {
      protocolVersion: body.protocolVersion || "1", descriptorSetHash: body.descriptorSetHash || "",
      capabilities: body.capabilities || {}, workspaces: executionNode.get(req.computeWorker.workerId)?.authorizedWorkspaces || [],
      networkScopes: executionNode.get(req.computeWorker.workerId)?.authorizedNetworkScopes || [], limits: body.limits || {},
    });
    const worker = compute.workerManager.heartbeat(req.computeWorker.workerId, { utilization: body.utilization, currentJobs: body.currentJobs, telemetry: body.telemetry });
    res.json({ ok: true, node, worker, workspaces: executionNode.listWorkspaces(req.computeWorker.workerId) });
  } catch (e) { sendComputeError(res, e, 400); }
}

function nodeClaimHandler(req, res) {
  try { const job = executionNode.claim(req.computeWorker.workerId, req.body?.leaseMs || 120000); res.json({ ok: true, claimed: !!job, job }); }
  catch (e) { sendComputeError(res, e, 409); }
}
function nodeCompleteHandler(req, res) {
  try { res.json({ ok: true, job: executionNode.finish(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId, req.body?.result, req.body?.receipt) }); }
  catch (e) { sendComputeError(res, e, 409); }
}
function nodeFailHandler(req, res) {
  try { res.json({ ok: true, job: executionNode.fail(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId, req.body?.code || "node_error", req.body?.message || "node execution failed") }); }
  catch (e) { sendComputeError(res, e, 409); }
}

const executionNodeEnrollmentRouter = express.Router();
executionNodeEnrollmentRouter.post("/exchange", express.json({ limit: "128kb" }), enforceEnrollmentRateLimit, enrollExecutionNodeHandler);
app.use("/execution-node/enrollment", executionNodeEnrollmentRouter);
const executionNodeRouter = express.Router();
executionNodeRouter.use(requireExecutionNode);
executionNodeRouter.post("/heartbeat", express.json({ limit: "128kb" }), nodeHeartbeatHandler);
executionNodeRouter.post("/jobs/claim", express.json({ limit: "16kb" }), nodeClaimHandler);
executionNodeRouter.post("/jobs/:jobId/complete", express.json({ limit: "1mb" }), nodeCompleteHandler);
executionNodeRouter.post("/jobs/:jobId/fail", express.json({ limit: "16kb" }), nodeFailHandler);
app.use("/execution-node/node", executionNodeRouter);

const executionNodeAdminRouter = express.Router();
executionNodeAdminRouter.use(requireAdmin);
executionNodeAdminRouter.get("/nodes", (req, res) => res.json({ ok: true, nodes: executionNode.list() }));
executionNodeAdminRouter.post("/nodes/:workerId/workspaces", express.json({ limit: "16kb" }), (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.rootIdentity) return res.status(400).json({ ok: false, error: "name and rootIdentity are required" });
    const workspaceId = executionNodeWorkspace.stableId("ws", `${body.name}:${body.rootIdentity}`);
    const workspace = executionNode.authorizeWorkspace(req.params.workerId, {
      workspaceId, name: String(body.name).slice(0, 64), rootIdentity: String(body.rootIdentity).slice(0, 128),
      permissions: body.permissions || { read: true, write: false, execute: false }, limits: body.limits || {},
    });
    res.json({ ok: true, workspace });
  } catch (e) { sendComputeError(res, e, 400); }
});
executionNodeAdminRouter.post("/nodes/:workerId/revoke", express.json({ limit: "8kb" }), (req, res) => {
  const worker = compute.workerManager.revokeWorker(req.params.workerId, req.body?.reason || "execution_node_revoked");
  if (!worker) return res.status(404).json({ ok: false, error: "node not found" });
  res.json({ ok: true, worker });
});
app.use("/execution-node/admin", executionNodeAdminRouter);

// Compatibility aliases for the initial compute HTTP protocol. These remain explicitly authenticated
// and are covered by the narrow global-auth bypass above only where worker/enrollment credentials differ.
app.post("/compute/enrollment-tokens", express.json({ limit: "16kb" }), requireAdmin, createEnrollmentTokenHandler);
app.post("/compute/enroll", express.json({ limit: "64kb" }), enforceEnrollmentRateLimit, enrollWorkerHandler);
app.post("/compute/heartbeat", express.json({ limit: "32kb" }), requireWorker, heartbeatHandler);
app.post("/compute/capabilities", express.json({ limit: "64kb" }), requireWorker, capabilitiesHandler);
app.post("/compute/credentials/rotate", express.json({ limit: "8kb" }), requireWorker, rotateCredentialHandler);
app.post("/compute/jobs", express.json({ limit: "256kb" }), requireAdmin, createJobHandler);
app.get("/compute/jobs", requireAdmin, listJobsHandler);
app.get("/compute/jobs/:jobId", requireAdmin, getJobHandler);
app.post("/compute/jobs/:jobId/cancel", express.json({ limit: "8kb" }), requireAdmin, cancelJobHandler);
app.post("/compute/jobs/claim", express.json({ limit: "16kb" }), requireWorker, claimJobHandler);
app.post("/compute/jobs/:jobId/start", express.json({ limit: "16kb" }), requireWorker, startJobHandler);
app.post("/compute/jobs/:jobId/renew", express.json({ limit: "16kb" }), requireWorker, renewJobHandler);
app.post("/compute/jobs/:jobId/progress", express.json({ limit: "16kb" }), requireWorker, progressJobHandler);
app.post("/compute/jobs/:jobId/cancellation", express.json({ limit: "16kb" }), requireWorker, cancellationStatusHandler);
app.post("/compute/jobs/:jobId/cancellation/ack", express.json({ limit: "16kb" }), requireWorker, cancellationAckHandler);
app.post("/compute/jobs/:jobId/artifacts/upload", express.json({ limit: "512kb" }), requireWorker, uploadArtifactHandler);
app.post("/compute/jobs/:jobId/artifacts/:artifactId/finalize", express.json({ limit: "64kb" }), requireWorker, finalizeArtifactHandler);
app.post("/compute/jobs/:jobId/complete", express.json({ limit: "512kb" }), requireWorker, completeJobHandler);
app.post("/compute/jobs/:jobId/fail", express.json({ limit: "64kb" }), requireWorker, failJobHandler);
app.post("/compute/recover", express.json({ limit: "8kb" }), requireAdmin, recoverJobsHandler);
app.get("/compute/health", requireAdmin, computeHealthHandler);

if (require.main === module && !IS_LOCAL) {
  httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log("Sidekick MCP server listening on port " + PORT);
    console.log("MCP endpoint: http://0.0.0.0:" + PORT + "/mcp");
    console.log("Data dir: " + DATA_DIR);
  });

  async function gracefulShutdown(signal) {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      console.log(`[Shutdown] Received ${signal}; closing resources`);
      if (httpServer) await new Promise(resolve => httpServer.close(() => resolve()));
      await sessionManager.dispose();
      if (browserSubsystem) await browserSubsystem.shutdown().catch(() => {});
      if (builtinModules) { try { builtinModules.stopModuleLifecycleTimers(); } catch {} }
      try { compute.stopReconciliation(); } catch {}
      if (eventDrainer) { try { eventDrainer.stopDrainer(); } catch {} }
      clearInterval(executionNodeRecoveryTimer);
      try { dbStore.closeDatabase(); } catch {}
    })();
    return shuttingDown;
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => gracefulShutdown(signal).then(() => process.exit(0)).catch(error => {
      console.error("[Shutdown] Failed:", error.message);
      process.exit(1);
    }));
  }
}

module.exports = { app, createMcpServer };
