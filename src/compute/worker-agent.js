#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SERVER_URL = process.env.SIDEKICK_URL || process.env.SIDEKICK_SERVER_URL || "http://127.0.0.1:4097";
const ENROLLMENT_TOKEN = process.env.SIDEKICK_ENROLL_TOKEN || process.env.COMPUTE_TOKEN || "";
const NODE_ID = process.env.SIDEKICK_NODE_ID || `node_${crypto.randomBytes(8).toString("hex")}`;
const DISPLAY_NAME = process.env.SIDEKICK_NODE_NAME || os.hostname();
const HEARTBEAT_MS = parseInt(process.env.SIDEKICK_HEARTBEAT_MS || "30000", 10);
const POLL_MS = parseInt(process.env.SIDEKICK_WORKER_POLL_MS || "2000", 10);
const LEASE_MS = parseInt(process.env.SIDEKICK_WORKER_LEASE_MS || "300000", 10);
const MAX_CONCURRENT_JOBS = parseInt(process.env.SIDEKICK_WORKER_CONCURRENCY || "1", 10);
const WORKER_VERSION = require("../../package.json").version || "0.0.0";
const PROTOCOL_VERSION = "1";
const CONFIG_PATH = process.env.SIDEKICK_WORKER_CONFIG || path.join(os.homedir(), ".sidekick", "worker-credential.json");

let workerId = null;
let credential = null;
let running = true;
const activeJobs = new Set();

function log(msg) { console.log(`[worker-agent] ${new Date().toISOString()} ${redact(msg)}`); }
function redact(value) { return String(value || "").replace(/(wksec_|enroll_)[A-Za-z0-9_-]+/g, "[REDACTED]"); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function credentialHeaders() {
  return workerId && credential ? { Authorization: `Bearer ${workerId}:${credential}` } : {};
}

function httpRequest(method, requestPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, SERVER_URL);
    const mod = url.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = mod.request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers }, (res) => {
      let data = "";
      res.on("data", c => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(new Error("Response too large")); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, data: { error: data.substring(0, 500) } }); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function collectSystemInfo() {
  const cpus = os.cpus();
  const accelerators = [];
  if (process.env.CUDA_VISIBLE_DEVICES !== undefined || process.env.NVIDIA_VISIBLE_DEVICES !== undefined) accelerators.push({ type: "cuda", visible: process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES });
  if (process.env.ROCR_VISIBLE_DEVICES !== undefined || process.env.HSA_OVERRIDE_GFX_VERSION !== undefined) accelerators.push({ type: "rocm", visible: process.env.ROCR_VISIBLE_DEVICES || process.env.HSA_OVERRIDE_GFX_VERSION });
  if (process.platform === "darwin" && os.arch() === "arm64") accelerators.push({ type: "metal", arch: os.arch() });
  return {
    architecture: os.arch(),
    cpuInfo: `${cpus[0]?.model || "unknown"} x${cpus.length}`,
    memoryBytes: os.totalmem(),
    accelerators,
    providers: configuredProviders(),
    executors: configuredExecutors(),
  };
}

function configuredProviders() {
  const providers = [{ type: "mock", endpoint: "in-process" }];
  if (process.env.OLLAMA_URL) providers.push({ type: "ollama", endpoint: process.env.OLLAMA_URL });
  return providers;
}

function configuredExecutors() {
  const executors = [{ type: "mock.inference", version: "1", capabilities: ["chat", "generate", "embeddings"] }];
  if (process.env.OLLAMA_URL) executors.push({ type: "ollama.inference", version: "1", capabilities: ["chat", "generate", "embeddings"] });
  return executors;
}

function loadCredential() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (parsed.workerId && parsed.credential) {
      workerId = parsed.workerId;
      credential = parsed.credential;
      return true;
    }
  } catch {}
  return false;
}

function saveCredential(worker, secret) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ workerId: worker.workerId, nodeId: worker.nodeId, credential: secret }, null, 2), { mode: 0o600 });
}

async function enrollIfNeeded() {
  if (loadCredential()) {
    log(`Loaded worker credential for ${workerId}`);
    return;
  }
  if (!ENROLLMENT_TOKEN) throw new Error("No enrollment token. Set SIDEKICK_ENROLL_TOKEN for first enrollment.");
  const sysInfo = collectSystemInfo();
  log(`Enrolling with ${SERVER_URL} as ${DISPLAY_NAME} (${NODE_ID})`);
  const result = await httpRequest("POST", "/compute/enroll", {
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
  const result = await httpRequest("POST", "/compute/heartbeat", {
    utilization: { cpuLoad: os.loadavg()[0] / os.cpus().length, memoryUsed: os.totalmem() - os.freemem(), memoryTotal: os.totalmem(), uptime: os.uptime(), processMemory: memUsage.rss },
    currentJobs: activeJobs.size,
    providers: sysInfo.providers,
    executors: sysInfo.executors,
    accelerators: sysInfo.accelerators,
    workerVersion: WORKER_VERSION,
  }, credentialHeaders());
  if (result.status !== 200 || !result.data.ok) log(`Heartbeat failed: ${result.data.error || result.status}`);
}

async function claimLoop() {
  while (running) {
    try {
      if (activeJobs.size < MAX_CONCURRENT_JOBS) {
        const result = await httpRequest("POST", "/compute/jobs/claim", { leaseDurationMs: LEASE_MS }, credentialHeaders());
        if (result.status === 200 && result.data.claimed) handleJob(result.data.job, result.data.leaseId).catch(e => log(`Job error: ${e.message}`));
        else await sleep(POLL_MS);
      } else {
        await sleep(POLL_MS);
      }
    } catch (e) {
      log(`Claim loop error: ${e.message}`);
      await sleep(POLL_MS * 2);
    }
  }
}

async function handleJob(job, leaseId) {
  activeJobs.add(job.jobId);
  let renewTimer = null;
  try {
    await httpRequest("POST", `/compute/jobs/${job.jobId}/start`, { leaseId }, credentialHeaders());
    renewTimer = setInterval(() => httpRequest("POST", `/compute/jobs/${job.jobId}/renew`, { leaseId, leaseDurationMs: LEASE_MS }, credentialHeaders()).catch(() => {}), Math.max(5000, Math.floor(LEASE_MS / 3)));
    await httpRequest("POST", `/compute/jobs/${job.jobId}/progress`, { leaseId, progressPercent: 25, progressMessage: "started" }, credentialHeaders());
    const result = await executeJob(job);
    await httpRequest("POST", `/compute/jobs/${job.jobId}/complete`, { leaseId, result }, credentialHeaders());
    log(`Completed job ${job.jobId}`);
  } catch (e) {
    await httpRequest("POST", `/compute/jobs/${job.jobId}/fail`, { leaseId, errorCategory: "worker_error", errorMessage: e.message }, credentialHeaders()).catch(() => {});
    log(`Failed job ${job.jobId}: ${e.message}`);
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    activeJobs.delete(job.jobId);
  }
}

async function executeJob(job) {
  const payload = job.requestPayload || {};
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

async function main() {
  log(`Starting worker agent v${WORKER_VERSION}`);
  await enrollIfNeeded();
  await sendHeartbeat().catch(e => log(`Initial heartbeat failed: ${e.message}`));
  const heartbeatTimer = setInterval(() => sendHeartbeat().catch(e => log(`Heartbeat error: ${e.message}`)), HEARTBEAT_MS);
  process.on("SIGINT", () => { running = false; clearInterval(heartbeatTimer); log("Shutting down"); });
  process.on("SIGTERM", () => { running = false; clearInterval(heartbeatTimer); log("Shutting down"); });
  await claimLoop();
}

if (require.main === module) {
  main().catch(e => { console.error(`[worker-agent] ${redact(e.message)}`); process.exit(1); });
}

module.exports = { collectSystemInfo, deterministicEmbedding, executeJob };
