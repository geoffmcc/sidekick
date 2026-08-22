"use strict";

const { execFile } = require("child_process");
const net = require("net");

const TELEMETRY_SCHEMA_VERSION = 1;
const MAX_DEVICES = 8;
const MAX_PROCESSES = 32;
const MAX_MODELS = 32;
const MAX_TEXT = 160;
// Windows NVIDIA driver queries can take longer when launched by a
// LocalSystem service than from an interactive shell. Keep the probe bounded
// while allowing normal driver initialization to complete.
const PROBE_TIMEOUT_MS = 2000;

function isLocalTelemetryEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = String(url.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || url.username || url.password) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const version = net.isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127 || octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
  }
  if (version === 6) {
    const normalized = host.replace(/^0+/, "");
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || normalized === "1";
  }
  // Docker/service names such as "ollama" are local to the worker network;
  // public dotted hostnames are deliberately not eligible for telemetry.
  return !host.includes(".");
}

function finiteNumber(value, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return undefined;
  return integer ? Math.round(number) : number;
}

function safeText(value, max = MAX_TEXT) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/[\0\r\n]/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function isoTimestamp(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function bytesFromMiB(value) {
  const number = finiteNumber(value, { min: 0, max: 1024 * 1024 });
  return number === undefined ? undefined : Math.round(number * 1024 * 1024);
}

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else field += char;
  }
  fields.push(field.trim());
  return fields;
}

function commandEnvironment(base = process.env) {
  // The collector receives only benign process-launch settings. In particular,
  // no secret-bearing environment variables are forwarded to the fixed probes.
  const env = {};
  for (const key of [
    "PATH", "SystemRoot", "WINDIR", "PATHEXT", "HOME", "USERPROFILE",
    // These benign Windows runtime locations are required by NVML when the
    // fixed nvidia-smi probe runs under the LocalSystem service account.
    "TEMP", "TMP", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
    "CommonProgramFiles", "CommonProgramFiles(x86)", "LOCALAPPDATA",
  ]) {
    if (base[key]) env[key] = String(base[key]);
  }
  return env;
}

function runFixedCommand(program, args, { execFileImpl = execFile, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(program, args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      shell: false,
      env: commandEnvironment(),
    }, (error, stdout) => {
      if (error) return reject(error);
      resolve(String(stdout || ""));
    });
  });
}

function normalizeProcessName(value) {
  const text = safeText(value, 96);
  if (!text) return "unknown";
  // Process output can contain an absolute path. Keep only the executable
  // basename so host layout and user directories never leave the worker.
  const basename = text.replace(/\\/g, "/").split("/").pop() || "unknown";
  return basename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "unknown";
}

function normalizeGpuRows(output) {
  const devices = [];
  for (const line of String(output || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, MAX_DEVICES)) {
    const fields = parseCsvLine(line);
    if (fields.length < 10) continue;
    devices.push({
      index: finiteNumber(fields[0], { min: 0, max: 128, integer: true }),
      name: safeText(fields[1], 120),
      driverVersion: safeText(fields[2], 48),
      memoryTotalBytes: bytesFromMiB(fields[3]),
      memoryUsedBytes: bytesFromMiB(fields[4]),
      memoryFreeBytes: bytesFromMiB(fields[5]),
      utilizationPercent: finiteNumber(fields[6], { min: 0, max: 100 }),
      powerWatts: finiteNumber(fields[7], { min: 0, max: 10000 }),
      graphicsClockMHz: finiteNumber(fields[8], { min: 0, max: 100000, integer: true }),
      temperatureC: finiteNumber(fields[9], { min: -100, max: 200 }),
    });
  }
  return devices;
}

function normalizeProcessRows(output) {
  const processes = [];
  for (const line of String(output || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, MAX_PROCESSES)) {
    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;
    const pid = finiteNumber(fields[0], { min: 1, max: 4_000_000, integer: true });
    const process = { name: normalizeProcessName(fields[1]), memoryBytes: bytesFromMiB(fields[2]) };
    // PIDs are intentionally reduced to a presence marker. They are not useful
    // to the Agent's performance diagnosis and would expose host process data.
    process.running = pid !== undefined;
    processes.push(process);
  }
  return processes;
}

async function collectGpuTelemetry(options = {}) {
  const platform = options.platform || process.platform;
  const program = platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
  const gpuArgs = [
    "--query-gpu=index,name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,power.draw,clocks.current.graphics,temperature.gpu",
    "--format=csv,noheader,nounits",
  ];
  const processArgs = [
    "--query-compute-apps=pid,process_name,used_memory",
    "--format=csv,noheader,nounits",
  ];
  try {
    const gpuOutput = await runFixedCommand(program, gpuArgs, options);
    const devices = normalizeGpuRows(gpuOutput);
    if (!devices.length) return { status: "unavailable", reason: "no_gpu_rows" };
    let processes = [];
    try { processes = normalizeProcessRows(await runFixedCommand(program, processArgs, options)); } catch {}
    return {
      status: "available",
      vendor: "nvidia",
      devices,
      processes,
      collectedAt: new Date().toISOString(),
    };
  } catch {
    return { status: "unavailable", reason: "nvidia_smi_unavailable" };
  }
}

function sanitizeInference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "unavailable" };
  const output = {
    status: value.status === "active" ? "active" : value.status === "unavailable" ? "unavailable" : "available",
    provider: safeText(value.provider, 48),
    model: safeText(value.model, MAX_TEXT),
    jobType: safeText(value.jobType, 32),
    totalDurationMs: finiteNumber(value.totalDurationMs, { min: 0, max: 86_400_000 }),
    loadDurationMs: finiteNumber(value.loadDurationMs, { min: 0, max: 86_400_000 }),
    promptEvalCount: finiteNumber(value.promptEvalCount, { min: 0, max: 10_000_000, integer: true }),
    evalCount: finiteNumber(value.evalCount, { min: 0, max: 10_000_000, integer: true }),
    evalDurationMs: finiteNumber(value.evalDurationMs, { min: 0, max: 86_400_000 }),
    tokensPerSecond: finiteNumber(value.tokensPerSecond, { min: 0, max: 1_000_000 }),
    observedAt: isoTimestamp(value.observedAt),
  };
  return Object.fromEntries(Object.entries(output).filter(([, item]) => item !== undefined));
}

function sanitizeLoadedModels(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_MODELS).map(model => ({
    name: safeText(model?.name, MAX_TEXT),
    sizeBytes: finiteNumber(model?.sizeBytes, { min: 0, max: 1024 ** 5 }),
    vramBytes: finiteNumber(model?.vramBytes, { min: 0, max: 1024 ** 5 }),
    expiresAt: isoTimestamp(model?.expiresAt),
  })).map(model => Object.fromEntries(Object.entries(model).filter(([, item]) => item !== undefined)));
}

function sanitizeTelemetry(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const system = input.system && typeof input.system === "object" ? input.system : {};
  const gpu = input.gpu && typeof input.gpu === "object" ? input.gpu : { status: "unavailable" };
  const devices = Array.isArray(gpu.devices) ? gpu.devices.slice(0, MAX_DEVICES).map(device => ({
    index: finiteNumber(device?.index, { min: 0, max: 128, integer: true }),
    name: safeText(device?.name, 120),
    driverVersion: safeText(device?.driverVersion, 48),
    memoryTotalBytes: finiteNumber(device?.memoryTotalBytes, { min: 0, max: 1024 ** 5 }),
    memoryUsedBytes: finiteNumber(device?.memoryUsedBytes, { min: 0, max: 1024 ** 5 }),
    memoryFreeBytes: finiteNumber(device?.memoryFreeBytes, { min: 0, max: 1024 ** 5 }),
    utilizationPercent: finiteNumber(device?.utilizationPercent, { min: 0, max: 100 }),
    powerWatts: finiteNumber(device?.powerWatts, { min: 0, max: 10000 }),
    graphicsClockMHz: finiteNumber(device?.graphicsClockMHz, { min: 0, max: 100000, integer: true }),
    temperatureC: finiteNumber(device?.temperatureC, { min: -100, max: 200 }),
  })).map(device => Object.fromEntries(Object.entries(device).filter(([, item]) => item !== undefined))) : [];
  const processes = Array.isArray(gpu.processes) ? gpu.processes.slice(0, MAX_PROCESSES).map(process => ({
    name: normalizeProcessName(process?.name),
    memoryBytes: finiteNumber(process?.memoryBytes, { min: 0, max: 1024 ** 5 }),
    running: process?.running === true,
  })) : [];
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    privacy: "local-only",
    collectedAt: isoTimestamp(input.collectedAt),
    system: Object.fromEntries(Object.entries({
      cpuLoad: finiteNumber(system.cpuLoad, { min: 0, max: 100 }),
      memoryUsedBytes: finiteNumber(system.memoryUsedBytes, { min: 0, max: 1024 ** 5 }),
      memoryTotalBytes: finiteNumber(system.memoryTotalBytes, { min: 0, max: 1024 ** 5 }),
      activeJobs: finiteNumber(system.activeJobs, { min: 0, max: 1000, integer: true }),
      processMemoryBytes: finiteNumber(system.processMemoryBytes, { min: 0, max: 1024 ** 5 }),
    }).filter(([, item]) => item !== undefined)),
    gpu: {
      status: gpu.status === "available" ? "available" : "unavailable",
      vendor: safeText(gpu.vendor, 40),
      reason: safeText(gpu.reason, 80),
      devices,
      processes,
      collectedAt: isoTimestamp(gpu.collectedAt),
    },
    loadedModels: sanitizeLoadedModels(input.loadedModels),
    inference: sanitizeInference(input.inference),
  };
}

function projectWorkerTelemetry(worker) {
  if (!worker) return null;
  const telemetry = sanitizeTelemetry(worker.telemetry);
  return {
    workerId: safeText(worker.workerId, 80),
    nodeId: safeText(worker.nodeId, 120),
    displayName: safeText(worker.displayName, 120),
    platform: safeText(worker.platform, 32),
    architecture: safeText(worker.architecture, 32),
    state: safeText(worker.state, 32),
    connectionState: safeText(worker.connectionState, 32),
    healthState: safeText(worker.healthState, 32),
    currentJobs: finiteNumber(worker.currentJobs, { min: 0, max: 1000, integer: true }),
    lastHeartbeat: isoTimestamp(worker.lastHeartbeat),
    telemetry,
  };
}

module.exports = {
  TELEMETRY_SCHEMA_VERSION,
  collectGpuTelemetry,
  isLocalTelemetryEndpoint,
  normalizeProcessName,
  parseCsvLine,
  projectWorkerTelemetry,
  sanitizeInference,
  sanitizeLoadedModels,
  sanitizeTelemetry,
};
