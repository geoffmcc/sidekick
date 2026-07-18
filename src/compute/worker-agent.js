#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// OpenVINO executor — optional; gracefully absent when disabled or on non-Windows.
let _openVinoExecutor = null;
let _openVinoInitDone = false;
async function getOpenVinoExecutor() {
  if (_openVinoInitDone) return _openVinoExecutor;
  _openVinoInitDone = true;
  try {
    _openVinoExecutor = require("./openvino-executor");
    await _openVinoExecutor.initOpenVinoExecutor();
  } catch (e) {
    log(`OpenVINO executor unavailable: ${e.message}`);
    _openVinoExecutor = null;
  }
  return _openVinoExecutor;
}

applyCliArgs(process.argv.slice(2));

const SERVER_URL = process.env.SIDEKICK_URL || process.env.SIDEKICK_SERVER_URL || "http://127.0.0.1:4097";
const ENROLLMENT_TOKEN = process.env.SIDEKICK_ENROLL_TOKEN || process.env.COMPUTE_TOKEN || "";
const NODE_ID = process.env.SIDEKICK_NODE_ID || `node_${crypto.randomBytes(8).toString("hex")}`;
const DISPLAY_NAME = process.env.SIDEKICK_NODE_NAME || os.hostname();
const HEARTBEAT_MS = boundedInt(process.env.SIDEKICK_HEARTBEAT_MS, 30000, 1000, 300000);
const POLL_MS = boundedInt(process.env.SIDEKICK_WORKER_POLL_MS, 2000, 100, 60000);
const LEASE_MS = boundedInt(process.env.SIDEKICK_WORKER_LEASE_MS, 300000, 30000, 1800000);
const MAX_CONCURRENT_JOBS = boundedInt(process.env.SIDEKICK_WORKER_CONCURRENCY, 1, 1, 16);
const MAX_RETRY_MS = boundedInt(process.env.SIDEKICK_WORKER_MAX_RETRY_MS, 30000, 1000, 300000);
const SHUTDOWN_GRACE_MS = boundedInt(process.env.SIDEKICK_WORKER_SHUTDOWN_GRACE_MS, 10000, 1000, 120000);
const DISCONNECT_TIMEOUT_MS = boundedInt(process.env.SIDEKICK_WORKER_DISCONNECT_TIMEOUT_MS, 3000, 250, 30000);
const OPENVINO_STARTUP_READINESS_MS = boundedInt(process.env.SIDEKICK_OPENVINO_STARTUP_READINESS_MS, 60000, 1000, 300000);
const WORKER_VERSION = require("../../package.json").version || "0.0.0";
const PROTOCOL_VERSION = "1";
const CONFIG_PATH = process.env.SIDEKICK_WORKER_CONFIG || path.join(os.homedir(), ".sidekick", "worker-credential.json");

let workerId = null;
let credential = null;
let running = true;
let shuttingDown = false;
let heartbeatTimer = null;
const activeJobs = new Set();
const activeJobPromises = new Set();

function applyCliArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: sidekick-compute-worker [enroll|run] [options]

Options:
  --server <url>       Sidekick MCP server URL, for example http://10.47.20.20:4097
  --token <token>      One-time enrollment token for first enrollment
  --name <name>        Worker display name
  --node-id <id>       Stable node ID for this machine
  --config <path>      Credential file path
  --concurrency <n>    Maximum concurrent jobs, 1-16
  --service <type>     Accepted for installer scripts; service registration is platform packaging
`);
    process.exit(0);
  }
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "run";
  if (!["run", "enroll"].includes(command)) {
    console.error(`Unknown worker command: ${command}`);
    process.exit(2);
  }
  const map = {
    "--server": "SIDEKICK_SERVER_URL",
    "--token": "SIDEKICK_ENROLL_TOKEN",
    "--name": "SIDEKICK_NODE_NAME",
    "--node-id": "SIDEKICK_NODE_ID",
    "--config": "SIDEKICK_WORKER_CONFIG",
    "--concurrency": "SIDEKICK_WORKER_CONCURRENCY",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--service") { i++; continue; }
    const envName = map[arg];
    if (!envName) continue;
    const value = args[++i];
    if (!value) {
      console.error(`Missing value for ${arg}`);
      process.exit(2);
    }
    process.env[envName] = value;
  }
}

function log(msg) { console.log(`[worker-agent] ${new Date().toISOString()} ${redact(msg)}`); }
function redact(value) { return String(value || "").replace(/(wksec_|enroll_)[A-Za-z0-9_-]+/g, "[REDACTED]"); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function boundedInt(value, fallback, min, max) {
  const parsed = parseInt(value || String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function jitteredBackoff(baseMs, attempt = 0) {
  const base = Math.min(MAX_RETRY_MS, Math.max(POLL_MS, baseMs) * Math.pow(2, attempt));
  const jitter = Math.floor(base * 0.2 * Math.random());
  return Math.min(MAX_RETRY_MS, base + jitter);
}

function credentialHeaders() {
  return workerId && credential ? { Authorization: `Bearer ${workerId}:${credential}` } : {};
}

function httpRequest(method, requestPath, body, extraHeaders = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, SERVER_URL);
    const mod = url.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = mod.request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers }, (res) => {
      let data = "";
      res.on("data", c => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(new Error("Response too large")); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, data: { error: data.substring(0, 500) } }); }
      });
    });
    req.setTimeout(options.timeoutMs || 15000, () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function requestWithRetry(method, requestPath, body, extraHeaders = {}, options = {}) {
  const attempts = options.attempts || 3;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await httpRequest(method, requestPath, body, extraHeaders);
      if (![408, 429, 500, 502, 503, 504].includes(result.status)) return result;
      lastErr = new Error(`HTTP ${result.status}: ${result.data?.error || "transient server error"}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < attempts - 1 && running) await sleep(jitteredBackoff(POLL_MS, attempt));
  }
  throw lastErr;
}

function collectSystemInfo() {
  const cpus = os.cpus();
  return {
    nodeId: NODE_ID,
    displayName: DISPLAY_NAME,
    workerVersion: WORKER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform: process.platform,
    osType: os.type(),
    osRelease: os.release(),
    nodeVersion: process.version,
    architecture: os.arch(),
    cpuInfo: `${cpus[0]?.model || "unknown"} x${cpus.length}`,
    cpuCount: cpus.length,
    memoryBytes: os.totalmem(),
    accelerators: configuredAccelerators(),
    providers: configuredProviders(),
    executors: configuredExecutors(),
    modelInventory: configuredModelInventory(),
    limits: configuredLimits(),
    health: configuredHealth(),
  };
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeString(value, max = 160) {
  return String(value || "").replace(/[\0\r\n]/g, " ").slice(0, max);
}

function sanitizeEndpoint(endpoint) {
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().slice(0, 300);
  } catch {
    return safeString(endpoint, 300);
  }
}

function normalizeCapabilities(value, fallback = ["chat", "generate", "embeddings"]) {
  const source = Array.isArray(value) ? value : fallback;
  return source.map(v => safeString(v, 40)).filter(Boolean).slice(0, 16);
}

function configuredAccelerators() {
  const configured = parseJsonEnv("SIDEKICK_WORKER_ACCELERATORS_JSON", []);
  const accelerators = Array.isArray(configured) ? configured.slice(0, 16).map(item => ({
    type: safeString(item.type || item.name || "unknown", 40),
    vendor: item.vendor ? safeString(item.vendor, 80) : undefined,
    name: item.name ? safeString(item.name, 120) : undefined,
    memoryBytes: Number.isFinite(Number(item.memoryBytes || item.memory_bytes)) ? Number(item.memoryBytes || item.memory_bytes) : undefined,
  })).filter(a => a.type) : [];
  if (process.env.CUDA_VISIBLE_DEVICES !== undefined || process.env.NVIDIA_VISIBLE_DEVICES !== undefined) accelerators.push({ type: "cuda", visible: safeString(process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES || "all", 80) });
  if (process.env.ROCR_VISIBLE_DEVICES !== undefined || process.env.HSA_OVERRIDE_GFX_VERSION !== undefined) accelerators.push({ type: "rocm", visible: safeString(process.env.ROCR_VISIBLE_DEVICES || process.env.HSA_OVERRIDE_GFX_VERSION || "all", 80) });
  if (process.platform === "darwin" && os.arch() === "arm64") accelerators.push({ type: "metal", arch: os.arch() });
  if (!accelerators.length) accelerators.push({ type: "cpu", arch: os.arch() });
  return accelerators;
}

function configuredProviders() {
  const providers = [{ type: "mock", endpoint: "in-process" }];
  const configured = parseJsonEnv("SIDEKICK_WORKER_BACKENDS_JSON", []);
  if (Array.isArray(configured)) {
    for (const item of configured.slice(0, 16)) {
      const type = safeString(item.type || item.provider || item.name, 40);
      if (type) providers.push({ type, endpoint: sanitizeEndpoint(item.endpoint || item.url), status: safeString(item.status || "configured", 40) });
    }
  }
  if (process.env.OLLAMA_URL) providers.push({ type: "ollama", endpoint: sanitizeEndpoint(process.env.OLLAMA_URL), status: "configured" });
  return providers;
}

function openVinoReadiness() {
  if (process.env.SIDEKICK_OPENVINO_ENABLED !== "true") {
    return { state: "disabled", capabilities: [], models: [] };
  }
  if (_openVinoExecutor && typeof _openVinoExecutor.getStartupReadiness === "function") {
    return _openVinoExecutor.getStartupReadiness();
  }
  // Enabled but the executor module has not been initialised yet.
  return { state: "probing", capabilities: [], models: [] };
}

function configuredExecutors() {
  const executors = [{ type: "mock.inference", version: "1", capabilities: ["chat", "generate", "embeddings"] }];
  if (process.env.OLLAMA_URL) executors.push({ type: "ollama.inference", version: "1", capabilities: ["chat", "generate", "embeddings"] });
  // Advertise the OpenVINO executor for routing ONLY once startup readiness has
  // established concrete certified profiles. Until then it is intentionally
  // absent from the routable executor set (its state is reported in health),
  // so the scheduler never routes an embedding job to a cold/uncertified path.
  if (process.env.SIDEKICK_OPENVINO_ENABLED === "true") {
    const readiness = openVinoReadiness();
    if (readiness.state === "ready" && Array.isArray(readiness.capabilities) && readiness.capabilities.length > 0) {
      executors.push({
        type: (_openVinoExecutor && _openVinoExecutor.EXECUTOR_TYPE) || "openvino.text_embedding",
        version: (_openVinoExecutor && _openVinoExecutor.EXECUTOR_VERSION) || "1",
        capabilities: readiness.capabilities.slice(0, 16),
        state: readiness.state,
      });
    }
  }
  return executors;
}

function configuredModelInventory() {
  const models = [{ name: "deterministic-test", provider: "mock", capabilities: ["chat", "generate", "embeddings"] }];
  const configured = parseJsonEnv("SIDEKICK_WORKER_MODELS_JSON", []);
  if (Array.isArray(configured)) {
    for (const item of configured.slice(0, 64)) {
      const name = safeString(item.name || item.model, 160);
      if (name) models.push({
        name,
        provider: safeString(item.provider || item.backend || "unknown", 80),
        capabilities: normalizeCapabilities(item.capabilities, ["chat", "generate"]),
        contextWindow: Number.isFinite(Number(item.contextWindow || item.context_window)) ? Number(item.contextWindow || item.context_window) : undefined,
      });
    }
  }
  if (process.env.OLLAMA_MODEL) models.push({ name: safeString(process.env.OLLAMA_MODEL, 160), provider: "ollama", capabilities: ["chat", "generate"] });
  // Populate OpenVINO models from the initialised executor's readiness snapshot
  // so model inventory always agrees with the advertised executor capabilities:
  // a model appears here only when at least one of its certified profiles is
  // ready, and never when the OpenVINO executor is not advertised.
  const ovReadiness = openVinoReadiness();
  if (ovReadiness.state === "ready" && Array.isArray(ovReadiness.models)) {
    for (const m of ovReadiness.models.slice(0, 16)) {
      const name = safeString(m.name, 160);
      if (!name) continue;
      const tier = m.certificationTier || "certified";
      models.push({
        name,
        provider: "openvino",
        capabilities: ["text_embedding"],
        device: safeString(m.device, 16),
        dimensions: Number.isFinite(Number(m.dimensions)) ? Number(m.dimensions) : undefined,
        embeddingSpaceId: m.embeddingSpaceId ? safeString(m.embeddingSpaceId, 80) : undefined,
        certificationTier: tier,
      });
    }
  }
  return models;
}

function configuredLimits() {
  return { maxConcurrentJobs: MAX_CONCURRENT_JOBS, leaseMs: LEASE_MS, maxResultBytes: 512 * 1024 };
}

function configuredHealth() {
  const health = {
    status: "healthy",
    checkedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    protocolVersion: PROTOCOL_VERSION,
    backends: configuredProviders().map(p => ({ type: p.type, endpoint: p.endpoint, status: p.status || "configured" })),
  };
  // Report the OpenVINO startup state honestly and independently of overall
  // worker health: a missing NPU or a faulted helper does not make the worker
  // unhealthy (E5 CPU and other executors remain usable). No sensitive paths.
  if (process.env.SIDEKICK_OPENVINO_ENABLED === "true") {
    const r = openVinoReadiness();
    health.openvino = {
      state: r.state,
      reason: r.reason ? safeString(r.reason, 200) : undefined,
      availableDevices: Array.isArray(r.availableDevices) ? r.availableDevices.slice(0, 8) : [],
      readyProfiles: Array.isArray(r.capabilities) ? r.capabilities.slice(0, 16) : [],
      models: Array.isArray(r.models) ? r.models.slice(0, 16).map(m => ({
        name: safeString(m.name, 160),
        certificationTier: m.certificationTier || "certified",
      })) : [],
      openVinoVersion: r.openVinoVersion || undefined,
      helperVersion: r.helperVersion || undefined,
    };
  }
  return health;
}

function loadCredential() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32" && (stat.mode & 0o077)) {
      fs.chmodSync(CONFIG_PATH, 0o600);
      log(`Tightened worker credential file permissions at ${CONFIG_PATH}`);
    }
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (/^wk_[A-Za-z0-9_-]+$/.test(parsed.workerId || "") && /^wksec_[A-Za-z0-9_-]+$/.test(parsed.credential || "")) {
      workerId = parsed.workerId;
      credential = parsed.credential;
      return true;
    }
  } catch {}
  return false;
}

function saveCredential(worker, secret) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(path.dirname(CONFIG_PATH), 0o700);
  const tempPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ workerId: worker.workerId, nodeId: worker.nodeId, credential: secret }, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, CONFIG_PATH);
}

async function enrollIfNeeded() {
  if (loadCredential()) {
    log(`Loaded worker credential for ${workerId}`);
    return;
  }
  if (!ENROLLMENT_TOKEN) throw new Error("No enrollment token. Set SIDEKICK_ENROLL_TOKEN for first enrollment.");
  const sysInfo = collectSystemInfo();
  log(`Enrolling with ${SERVER_URL} as ${DISPLAY_NAME} (${NODE_ID})`);
  const result = await requestWithRetry("POST", "/compute/enrollment/exchange", {
    token: ENROLLMENT_TOKEN,
    nodeId: NODE_ID,
    displayName: DISPLAY_NAME,
    platform: process.platform,
    architecture: sysInfo.architecture,
    cpuInfo: sysInfo.cpuInfo,
    memoryBytes: sysInfo.memoryBytes,
    accelerators: sysInfo.accelerators,
    providers: sysInfo.providers,
    executors: sysInfo.executors,
    modelInventory: sysInfo.modelInventory,
    limits: sysInfo.limits,
    health: sysInfo.health,
    workerVersion: WORKER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  });
  if (result.status !== 200 || !result.data.ok) throw new Error(`Enrollment failed (${result.status}): ${result.data.error || "unknown"}`);
  workerId = result.data.worker.workerId;
  credential = result.data.credential;
  saveCredential(result.data.worker, credential);
  log(`Enrolled successfully. Worker ID: ${workerId}`);
}

async function sendHeartbeat() {
  const sysInfo = collectSystemInfo();
  const memUsage = process.memoryUsage();
  const result = await requestWithRetry("POST", "/compute/worker/heartbeat", {
    utilization: { cpuLoad: os.loadavg()[0] / os.cpus().length, memoryUsed: os.totalmem() - os.freemem(), memoryTotal: os.totalmem(), uptime: os.uptime(), processMemory: memUsage.rss },
    currentJobs: activeJobs.size,
    providers: sysInfo.providers,
    executors: sysInfo.executors,
    accelerators: sysInfo.accelerators,
    modelInventory: sysInfo.modelInventory,
    limits: sysInfo.limits,
    health: sysInfo.health,
    workerVersion: WORKER_VERSION,
  }, credentialHeaders());
  if (result.status !== 200 || !result.data.ok) log(`Heartbeat failed: ${result.data.error || result.status}`);
}

async function claimLoop() {
  let errorAttempt = 0;
  while (running) {
    try {
      if (activeJobs.size < MAX_CONCURRENT_JOBS) {
        const result = await requestWithRetry("POST", "/compute/worker/jobs/claim", { leaseDurationMs: LEASE_MS }, credentialHeaders(), { attempts: 2 });
        errorAttempt = 0;
        if (result.status === 200 && result.data.claimed) {
          const jobPromise = handleJob(result.data.job, result.data.leaseId).catch(e => log(`Job error: ${e.message}`));
          activeJobPromises.add(jobPromise);
          jobPromise.finally(() => activeJobPromises.delete(jobPromise));
        }
        else await sleep(POLL_MS);
      } else {
        await sleep(POLL_MS);
      }
    } catch (e) {
      log(`Claim loop error: ${e.message}`);
      await sleep(jitteredBackoff(POLL_MS, errorAttempt++));
    }
  }
}

async function handleJob(job, leaseId) {
  activeJobs.add(job.jobId);
  let renewTimer = null;
  try {
    await assertOk(requestWithRetry("POST", `/compute/worker/jobs/${job.jobId}/start`, { leaseId }, credentialHeaders()), "start");
    renewTimer = setInterval(() => requestWithRetry("POST", `/compute/worker/jobs/${job.jobId}/renew`, { leaseId, leaseDurationMs: LEASE_MS }, credentialHeaders(), { attempts: 2 }).catch(e => log(`Renew failed for ${job.jobId}: ${e.message}`)), Math.max(5000, Math.floor(LEASE_MS / 3)));
    await assertOk(requestWithRetry("POST", `/compute/worker/jobs/${job.jobId}/progress`, { leaseId, progressPercent: 25, progressMessage: "started" }, credentialHeaders()), "progress");
    const cancellationCheck = () => checkCancellation(job.jobId, leaseId);
    const result = await executeJob(job, cancellationCheck);
    if (await cancellationCheck()) {
      await acknowledgeCancellation(job.jobId, leaseId);
      log(`Acknowledged cancellation for job ${job.jobId}`);
      return;
    }
    const validationError = validateJobResult(result);
    if (validationError) {
      await requestWithRetry("POST", `/compute/worker/jobs/${job.jobId}/fail`, {
        leaseId,
        errorCategory: validationError.category,
        errorMessage: validationError.message,
      }, credentialHeaders(), { attempts: 2 }).catch(() => {});
      log(`Failed job ${job.jobId}: ${validationError.message}`);
      return;
    }
    const resultContent = typeof result.content === "string" ? result.content : JSON.stringify(result).slice(0, 1000);
    const resultArtifact = await publishResultArtifact(job.jobId, leaseId, resultContent);
    const completed = await requestWithRetry("POST", `/compute/worker/jobs/${job.jobId}/complete`, {
      leaseId,
      result,
      artifactIds: [resultArtifact.artifactId],
    }, credentialHeaders());
    if (completed.status === 409) {
      log(`Job ${job.jobId} was no longer completable: ${completed.data.error || completed.status}`);
      return;
    }
    await assertOk(Promise.resolve(completed), "complete");
    log(`Completed job ${job.jobId}`);
  } catch (e) {
    if (/cancellation requested/i.test(e.message)) {
      await acknowledgeCancellation(job.jobId, leaseId);
      log(`Acknowledged cancellation for job ${job.jobId}`);
    } else if (shuttingDown) log(`Leaving job ${job.jobId} leased during graceful shutdown`);
    else await requestWithRetry("POST", `/compute/worker/jobs/${job.jobId}/fail`, { leaseId, errorCategory: "worker_error", errorMessage: e.message }, credentialHeaders(), { attempts: 2 }).catch(() => {});
    if (!/cancellation requested/i.test(e.message)) log(`Failed job ${job.jobId}: ${e.message}`);
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    activeJobs.delete(job.jobId);
  }
}

function validateJobResult(result) {
  if (!result || typeof result !== "object") {
    return { category: "RESULT_VALIDATION_FAILED", message: "Provider returned non-object result" };
  }
  const content = result.content;
  const embedding = result.embedding;
  const hasEmbedding = Array.isArray(embedding) && embedding.length > 0;
  const hasContent = typeof content === "string";
  if (!hasContent && !hasEmbedding) {
    return { category: "EMPTY_PROVIDER_RESULT", message: "Provider returned result with no content or embedding" };
  }
  if (hasContent && content.trim().length === 0) {
    return { category: "EMPTY_PROVIDER_RESULT", message: "Provider returned empty or whitespace-only content" };
  }
  if (hasContent && content.length > 10 * 1024 * 1024) {
    return { category: "RESULT_VALIDATION_FAILED", message: `Content exceeds maximum size: ${content.length} bytes` };
  }
  return null;
}

async function checkCancellation(jobId, leaseId) {
  try {
    const result = await requestWithRetry("POST", `/compute/worker/jobs/${jobId}/cancellation`, { leaseId }, credentialHeaders(), { attempts: 1 });
    return result.status === 200 && !!result.data?.cancellation?.cancelled;
  } catch {
    return false;
  }
}

async function acknowledgeCancellation(jobId, leaseId) {
  await requestWithRetry("POST", `/compute/worker/jobs/${jobId}/cancellation/ack`, { leaseId }, credentialHeaders(), { attempts: 2 }).catch(() => {});
}

async function publishResultArtifact(jobId, leaseId, content) {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const upload = await assertOk(requestWithRetry("POST", `/compute/worker/jobs/${jobId}/artifacts/upload`, {
    leaseId,
    name: "result.txt",
    content,
    contentType: "text/plain",
    artifactType: "result",
    contentHash: hash,
    sizeBytes: Buffer.byteLength(content),
  }, credentialHeaders()), "artifact upload");
  const finalize = await assertOk(requestWithRetry("POST", `/compute/worker/jobs/${jobId}/artifacts/${upload.data.artifact.artifactId}/finalize`, {
    leaseId,
    contentHash: hash,
    sizeBytes: Buffer.byteLength(content),
  }, credentialHeaders()), "artifact finalize");
  return finalize.data.artifact;
}

async function assertOk(resultPromise, action) {
  const result = await resultPromise;
  if (result.status < 200 || result.status >= 300 || result.data?.ok === false) {
    throw new Error(`${action} failed (${result.status}): ${result.data?.error || "unknown"}`);
  }
  return result;
}

async function executeJob(job, shouldCancel = async () => false) {
  const payload = job.requestPayload || {};
  const delayMs = Math.max(0, Math.min(30000, Number(payload.delayMs || payload.delay_ms || 0)));
  let remainingDelay = delayMs;
  while (remainingDelay > 0) {
    if (await shouldCancel()) throw new Error("Job cancellation requested");
    const chunk = Math.min(250, remainingDelay);
    await sleep(chunk);
    remainingDelay -= chunk;
  }
  // OpenVINO text embedding jobs.
  const executor = payload.executor || payload.executorType || "";
  if (executor === "openvino.text_embedding" || job.capability === "openvino.text_embedding") {
    const ov = await getOpenVinoExecutor();
    if (!ov) throw new Error("OpenVINO executor is not available on this worker");
    return ov.executeOpenVinoEmbed(null, payload);
  }
  if (job.capability === "embeddings" || job.jobType === "embeddings" || job.jobType === "embedding") {
    const text = String(payload.input || payload.text || "");
    return { embedding: deterministicEmbedding(text), model: payload.model || "deterministic-test" };
  }
  if (process.env.OLLAMA_URL && (payload.backend === "ollama" || payload.provider === "ollama")) {
    return ollamaGenerate(payload);
  }
  const prompt = payload.prompt || (Array.isArray(payload.messages) ? payload.messages.map(m => m.content).join("\n") : "");
  return { content: `mock:${String(prompt).slice(0, 200)}`, model: payload.model || "deterministic-test", workerId };
}

async function ollamaGenerate(payload) {
  const endpoint = new URL("/api/generate", process.env.OLLAMA_URL);
  const body = JSON.stringify({ model: payload.model, prompt: payload.prompt || "Hello", stream: false, options: { num_predict: payload.maxTokens || 64 } });
  const result = await httpRequest("POST", endpoint.href, JSON.parse(body));
  if (result.status !== 200) throw new Error(`Ollama request failed: ${result.status}`);
  return { content: result.data.response || "", model: payload.model, provider: "ollama" };
}

function deterministicEmbedding(text) {
  const h = crypto.createHash("sha256").update(text).digest();
  return Array.from({ length: 16 }, (_, i) => (h[i] - 128) / 128);
}

// Initialise the OpenVINO executor through a bounded readiness path before the
// worker advertises itself. This makes the very first enrollment/heartbeat carry
// accurate executor capabilities and model inventory without needing a job. It
// is a no-op (returns immediately) when OpenVINO is not enabled.
async function establishOpenVinoReadiness() {
  if (process.env.SIDEKICK_OPENVINO_ENABLED !== "true") return;
  log("Establishing OpenVINO startup readiness...");
  let ov;
  try {
    ov = await getOpenVinoExecutor();
  } catch (e) {
    log(`OpenVINO executor initialisation failed: ${e.message}`);
    return;
  }
  if (!ov || typeof ov.awaitStartupReadiness !== "function") {
    log("OpenVINO executor unavailable; advertising without OpenVINO capabilities");
    return;
  }
  try {
    const r = await ov.awaitStartupReadiness(OPENVINO_STARTUP_READINESS_MS);
    const profileCount = Array.isArray(r.capabilities) ? r.capabilities.length : 0;
    log(`OpenVINO startup readiness: ${r.state}${profileCount ? ` (${profileCount} profile(s): ${r.capabilities.join(", ")})` : ""}`);
  } catch (e) {
    log(`OpenVINO startup readiness error: ${e.message}`);
  }
}

async function main() {
  log(`Starting worker agent v${WORKER_VERSION}`);
  // Register signal handlers first so a shutdown during startup readiness is
  // handled cleanly (aborts the readiness wait; no orphaned helper).
  process.on("SIGINT", () => { requestShutdown("SIGINT").catch(() => {}); });
  process.on("SIGTERM", () => { requestShutdown("SIGTERM").catch(() => {}); });
  await establishOpenVinoReadiness();
  if (!running) { await waitForActiveJobs(); return; }
  await enrollIfNeeded();
  if (!running) { await waitForActiveJobs(); return; }
  await sendHeartbeat().catch(e => log(`Initial heartbeat failed: ${e.message}`));
  heartbeatTimer = setInterval(() => sendHeartbeat().catch(e => log(`Heartbeat error: ${e.message}`)), HEARTBEAT_MS);
  await claimLoop();
  await waitForActiveJobs();
}

// Best-effort graceful disconnect. Tells the server to mark this worker offline
// immediately on shutdown instead of waiting out the heartbeat-miss threshold.
// Bounded by DISCONNECT_TIMEOUT_MS; any failure is swallowed since the server's
// reconciliation loop is the backstop.
async function sendDisconnect(reason) {
  if (!workerId || !credential) return false;
  try {
    const res = await httpRequest("POST", "/compute/worker/disconnect", { reason }, credentialHeaders(), { timeoutMs: DISCONNECT_TIMEOUT_MS });
    if (res.status === 200) { log("Sent graceful disconnect"); return true; }
    log(`Disconnect notification returned HTTP ${res.status} (best-effort)`);
  } catch (e) {
    log(`Disconnect notification failed (best-effort): ${e.message}`);
  }
  return false;
}

async function requestShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  log(`Shutting down after ${signal}`);
  // Notify the server before tearing down local resources so it marks us offline
  // promptly rather than waiting for missed heartbeats (best-effort, bounded).
  await sendDisconnect(`worker_shutdown:${signal}`);
  // Shut down the OpenVINO helper process if running.
  if (_openVinoExecutor && _openVinoExecutor.shutdownOpenVinoExecutor) {
    try { _openVinoExecutor.shutdownOpenVinoExecutor(); } catch {}
  }
}

async function waitForActiveJobs() {
  if (!activeJobPromises.size) return;
  const timeout = sleep(SHUTDOWN_GRACE_MS).then(() => "timeout");
  const finished = Promise.allSettled(Array.from(activeJobPromises)).then(() => "finished");
  const outcome = await Promise.race([timeout, finished]);
  if (outcome === "timeout") log(`Shutdown grace expired with ${activeJobPromises.size} active job(s)`);
}

if (require.main === module) {
  main().catch(e => { console.error(`[worker-agent] ${redact(e.message)}`); process.exit(1); });
}

// Test seam: inject a stand-in OpenVINO executor module so the advertisement
// shaping (executors/modelInventory/health) can be exercised without spawning a
// real Python helper. Not used in production paths.
function __setOpenVinoExecutorForTest(mod) {
  _openVinoExecutor = mod;
  _openVinoInitDone = true;
}

// Test seam: inject worker identity so the graceful-disconnect path can be
// exercised without running the full enrollment flow.
function __setWorkerIdentityForTest(id, cred) {
  workerId = id;
  credential = cred;
}

module.exports = { collectSystemInfo, configuredExecutors, configuredModelInventory, configuredHealth, deterministicEmbedding, executeJob, validateJobResult, boundedInt, jitteredBackoff, redact, getOpenVinoExecutor, sendDisconnect, requestShutdown, __setOpenVinoExecutorForTest, __setWorkerIdentityForTest };
