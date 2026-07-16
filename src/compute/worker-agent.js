#!/usr/bin/env node
const http = require("http");
const https = require("https");
const os = require("os");
const crypto = require("crypto");

const SERVER_URL = process.env.SIDEKICK_URL || process.env.SIDEKICK_SERVER_URL || "http://127.0.0.1:4097";
const ENROLLMENT_TOKEN = process.env.SIDEKICK_ENROLL_TOKEN || process.env.COMPUTE_TOKEN || "";
const NODE_ID = process.env.SIDEKICK_NODE_ID || `node_${crypto.randomBytes(8).toString("hex")}`;
const DISPLAY_NAME = process.env.SIDEKICK_NODE_NAME || os.hostname();
const HEARTBEAT_MS = parseInt(process.env.SIDEKICK_HEARTBEAT_MS || "30000", 10);
const WORKER_VERSION = require("../../package.json").version || "0.0.0";

let workerId = null;
let running = true;

function log(msg) {
  console.log(`[worker-agent] ${new Date().toISOString()} ${msg}`);
}

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: { error: data.substring(0, 200) } }); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function collectSystemInfo() {
  const cpus = os.cpus();
  const accelerators = [];
  const providers = [];
  const executors = [];

  if (process.env.CUDA_VISIBLE_DEVICES !== undefined || process.env.NVIDIA_VISIBLE_DEVICES !== undefined) {
    accelerators.push({ type: "cuda", name: "NVIDIA GPU", visible: process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES });
  }
  if (process.env.ROCR_VISIBLE_DEVICES !== undefined || process.env.HSA_OVERRIDE_GFX_VERSION !== undefined) {
    accelerators.push({ type: "rocm", name: "AMD GPU", visible: process.env.ROCR_VISIBLE_DEVICES || process.env.HSA_OVERRIDE_GFX_VERSION });
  }
  if (process.platform === "darwin") {
    accelerators.push({ type: "metal", name: "Apple Silicon", arch: os.arch() });
  }

  const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  providers.push({ type: "ollama", endpoint: ollamaUrl });

  executors.push({ type: "builtin", name: "system.bash" });

  return {
    architecture: os.arch(),
    cpuInfo: `${cpus[0]?.model || "unknown"} x${cpus.length}`,
    memoryBytes: os.totalmem(),
    accelerators,
    providers,
    executors,
  };
}

async function enroll() {
  if (!ENROLLMENT_TOKEN) {
    log("ERROR: No enrollment token. Set SIDEKICK_ENROLL_TOKEN or COMPUTE_TOKEN.");
    log("Usage: SIDEKICK_URL=http://server:4097 SIDEKICK_ENROLL_TOKEN=<token> node worker-agent.js");
    process.exit(1);
  }

  const sysInfo = collectSystemInfo();
  log(`Enrolling with ${SERVER_URL} as "${DISPLAY_NAME}" (${NODE_ID})...`);

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
  });

  if (result.status !== 200 || !result.data.ok) {
    log(`Enrollment failed (${result.status}): ${result.data.error || JSON.stringify(result.data)}`);
    process.exit(1);
  }

  workerId = result.data.worker.workerId;
  log(`Enrolled successfully. Worker ID: ${workerId}`);
  log(`State: ${result.data.worker.state}, Trust: ${result.data.worker.trustLevel}`);
  return result.data.worker;
}

async function sendHeartbeat() {
  if (!workerId) return;
  try {
    const memUsage = process.memoryUsage();
    const result = await httpRequest("POST", "/compute/heartbeat", {
      workerId,
      utilization: {
        cpuLoad: os.loadavg()[0] / os.cpus().length,
        memoryUsed: os.totalmem() - os.freemem(),
        memoryTotal: os.totalmem(),
        uptime: os.uptime(),
        processMemory: memUsage.rss,
      },
      currentJobs: 0,
    });
    if (result.status !== 200 || !result.data.ok) {
      log(`Heartbeat failed: ${result.data.error || result.status}`);
    }
  } catch (e) {
    log(`Heartbeat error: ${e.message}`);
  }
}

async function main() {
  log(`Starting worker agent v${WORKER_VERSION}`);
  log(`Server: ${SERVER_URL}`);
  log(`Node: ${DISPLAY_NAME} (${NODE_ID})`);
  log(`Platform: ${process.platform} ${os.arch()}`);

  try {
    await enroll();
  } catch (e) {
    log(`Enrollment failed: ${e.message}`);
    process.exit(1);
  }

  const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  sendHeartbeat();

  process.on("SIGINT", () => {
    log("Shutting down...");
    running = false;
    clearInterval(heartbeatTimer);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    log("Shutting down...");
    running = false;
    clearInterval(heartbeatTimer);
    process.exit(0);
  });

  log(`Heartbeat every ${HEARTBEAT_MS}ms. Press Ctrl+C to stop.`);
}

main();
