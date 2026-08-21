"use strict";

// Media and analysis tool family: ocr, media, transcribe, analytics,
// insight_report, download.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, zod,
// shared non-legacy modules (path-policy, core/command-validation,
// core/format) and the yaml/fast-xml-parser/ini parsers (used by
// insight_report's summarizeInsightData) — never on tools-legacy.js.
// safeExecFileSync moves here with its only callers (verified exclusive to
// this cluster). insight_report calls sidekick_ocr in-family. One deliberate
// behavior fix, called out in review: sidekick_analytics used os.tmpdir()
// without requiring "os", so every analytics call with a file/query failed
// with "os is not defined" — this module adds the missing require, restoring
// the documented behavior. Risk classifications are preserved from
// src/tools/metadata.js and gated by the dispatcher.

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { childProcessEnv } = require("../../security/child-process");
const { z } = require("zod");
const { enforcePathPolicy } = require("../path-policy");
const { validateOutboundUrl, resolveOutboundUrl } = require("../../security/outbound-url");
const { validDownloadFormat, validLangCode, validScale, validTimestamp, validWhisperModel } = require("../../core/command-validation");

const YAML = require("yaml");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const INI = require("ini");

const { detectFormat } = require("../../core/format");
const { DATA_DIR } = require("../../db");
const platformKernel = require("../../platform/kernel");

const TRANSCRIPTION_JOB_ROOT = path.join(DATA_DIR, "transcription-jobs");
const transcriptionJobs = new Map();

function transcriptionJobPath(jobId) {
  return path.join(TRANSCRIPTION_JOB_ROOT, `${jobId}.json`);
}

function saveTranscriptionJob(job) {
  fs.mkdirSync(TRANSCRIPTION_JOB_ROOT, { recursive: true, mode: 0o700 });
  const safe = { ...job };
  delete safe.child;
  fs.writeFileSync(transcriptionJobPath(job.job_id), JSON.stringify(safe, null, 2), { mode: 0o600 });
  transcriptionJobs.set(job.job_id, job);
}

function loadTranscriptionJob(jobId) {
  if (transcriptionJobs.has(jobId)) return transcriptionJobs.get(jobId);
  try {
    const job = JSON.parse(fs.readFileSync(transcriptionJobPath(jobId), "utf8"));
    // The child process is intentionally not detached. A restart cannot
    // safely resume it, so expose that fact instead of reporting a job as
    // running forever after the parent process has gone away.
    if (job.status === "running" || job.status === "queued") {
      job.status = "orphaned";
      job.error = "Sidekick restarted before transcription completed";
      job.updated_at = new Date().toISOString();
      fs.writeFileSync(transcriptionJobPath(jobId), JSON.stringify(job, null, 2), { mode: 0o600 });
    }
    transcriptionJobs.set(jobId, job);
    return job;
  } catch (_) {
    return null;
  }
}

function commandAvailable(command) {
  return path.isAbsolute(command) ? fs.existsSync(command) : false;
}

function localCudaAvailable() {
  try {
    execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch (_) {
    return false;
  }
}

function localMetalAvailable() {
  return process.platform === "darwin" && process.arch === "arm64";
}

function localVulkanAvailable() {
  try {
    execFileSync("vulkaninfo", ["--summary"], { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch (_) {
    return false;
  }
}

function selectTranscriptionDevice(backend, requested) {
  const device = requested || process.env.SIDEKICK_TRANSCRIPTION_DEVICE || "auto";
  if (!["auto", "cpu", "cuda", "metal", "vulkan"].includes(device)) {
    throw new Error("Invalid transcription device. Use auto, cpu, cuda, metal, or vulkan");
  }
  if (device === "cpu") return "cpu";
  if (device === "cuda") {
    if (!localCudaAvailable()) throw new Error("CUDA requested but no local NVIDIA GPU was detected");
    return backend === "whisper.cpp" || backend === "faster-whisper" ? "cuda" : "cpu";
  }
  if (device === "metal") {
    if (!localMetalAvailable()) throw new Error("Metal requested but Apple Silicon was not detected");
    return backend === "whisper.cpp" ? "metal" : "cpu";
  }
  if (device === "vulkan") {
    if (!localVulkanAvailable()) throw new Error("Vulkan requested but no local Vulkan device was detected");
    return backend === "whisper.cpp" ? "vulkan" : "cpu";
  }
  if (backend === "whisper.cpp" && localMetalAvailable()) return "metal";
  if ((backend === "whisper.cpp" || backend === "faster-whisper") && localCudaAvailable()) return "cuda";
  if (backend === "whisper.cpp" && localVulkanAvailable()) return "vulkan";
  return "cpu";
}

function selectTranscriptionBackend(requested) {
  const whisper = "/home/sidekick/.sidekick-tools/bin/whisper";
  const fasterWhisper = "/home/sidekick/.sidekick-tools/bin/faster-whisper";
  const whisperCpp = "/home/sidekick/.sidekick-tools/bin/whisper-cli";
  const available = {
    "faster-whisper": commandAvailable(fasterWhisper),
    "whisper.cpp": commandAvailable(whisperCpp),
    whisper: commandAvailable(whisper),
  };
  const backend = requested || "auto";
  if (backend !== "auto" && !Object.prototype.hasOwnProperty.call(available, backend)) {
    throw new Error("Invalid transcription backend. Use auto, faster-whisper, whisper.cpp, or whisper");
  }
  if (backend !== "auto" && !available[backend]) {
    throw new Error(`Transcription backend not installed: ${backend}`);
  }
  if (backend === "auto") {
    // Prefer the optimized implementations, but never claim GPU use: the
    // selected executable remains responsible for its own device policy.
    if (available["faster-whisper"]) return { name: "faster-whisper", command: fasterWhisper };
    if (available["whisper.cpp"]) return { name: "whisper.cpp", command: whisperCpp };
    if (available.whisper) return { name: "whisper", command: whisper };
    return { name: "whisper", command: "whisper" };
  }
  return { name: backend, command: { "faster-whisper": fasterWhisper, "whisper.cpp": whisperCpp, whisper }[backend] };
}

function transcriptionArgs(backend, device, audioPath, model, language, outputDir) {
  if (backend === "whisper.cpp") {
    const prefix = path.join(outputDir, "transcript");
    const modelPath = `/home/sidekick/.sidekick-tools/models/ggml-${model}.bin`;
    return ["-m", modelPath, "-f", audioPath, "-otxt", "-of", prefix, ...(device === "cpu" ? ["-ng"] : []), ...(language ? ["-l", language] : [])];
  }
  return [audioPath, "--model", model, "--output_format", "txt", "--output_dir", outputDir, "--device", device, ...(backend === "faster-whisper" ? ["--compute_type", "auto"] : []), ...(language ? ["--language", language] : [])];
}

function finishTranscriptionJob(job, patch) {
  Object.assign(job, patch, { updated_at: new Date().toISOString() });
  saveTranscriptionJob(job);
}

function startTranscriptionJob({ audioPath, model, language, backend, device: requestedDevice }) {
  const selected = selectTranscriptionBackend(backend);
  const device = selectTranscriptionDevice(selected.name, requestedDevice);
  const jobId = `tr_${crypto.randomUUID()}`;
  const outputDir = path.join(TRANSCRIPTION_JOB_ROOT, jobId);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const job = { job_id: jobId, status: "queued", backend: selected.name, device, model, language: language || null, input: audioPath, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  saveTranscriptionJob(job);

  const child = spawn(selected.command, transcriptionArgs(selected.name, device, audioPath, model, language, outputDir), {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: childProcessEnv(),
  });
  job.child = child;
  finishTranscriptionJob(job, { status: "running" });
  child.stdout.on("data", () => {});
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.on("error", error => finishTranscriptionJob(job, { status: "failed", error: error.message }));
  child.on("close", code => {
    if (job.status === "cancelled") return;
    const txtPath = selected.name === "whisper.cpp"
      ? path.join(outputDir, "transcript.txt")
      : path.join(outputDir, `${path.basename(audioPath).replace(/\.[^.]+$/, "")}.txt`);
    if (code === 0 && fs.existsSync(txtPath)) finishTranscriptionJob(job, { status: "completed", output: fs.readFileSync(txtPath, "utf8").slice(0, 2 * 1024 * 1024).trim() || "(no speech detected)" });
    else finishTranscriptionJob(job, { status: "failed", error: stderr || `transcription exited with code ${code}` });
  });
  return job;
}

function safeExecFileSync(command, args, options = {}) {
  return execFileSync(command, args, {
    timeout: options.timeout || 30000,
    encoding: options.encoding || "utf8",
    maxBuffer: options.maxBuffer || 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: childProcessEnv(options.env),
  });
}

function mediaContentType(filePath, audioOnly) {
  if (audioOnly) return "audio/mpeg";
  const types = { ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".opus": "audio/opus" };
  return types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function sidekick_ocr({ path: imagePath, language, psm }) {
  try {
    const policyError = enforcePathPolicy(imagePath, "read");
    if (policyError) return policyError;
    if (!fs.existsSync(imagePath)) {
      return { content: [{ type: "text", text: `Error: File not found: ${imagePath}` }], isError: true };
    }

    const lang = validLangCode(language, "eng");
    const args = [imagePath, "stdout", "-l", lang];
    if (psm !== undefined) {
      const parsedPsm = Number(psm);
      if (!Number.isInteger(parsedPsm) || parsedPsm < 0 || parsedPsm > 13) throw new Error("Invalid OCR page segmentation mode");
      args.push("--psm", String(parsedPsm));
    }
    const result = safeExecFileSync("tesseract", args, { timeout: 30000 }).trim();

    return { content: [{ type: "text", text: result || "(no text detected)" }] };
  } catch (e) {
    if (e.message.includes("not found") || e.message.includes("ENOENT")) {
      return { content: [{ type: "text", text: "Error: tesseract not installed. Run: sudo apt install tesseract-ocr" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_media({ action, input, output, options }) {
  try {
    if (!input) {
      return { content: [{ type: "text", text: "Error: input is required" }], isError: true };
    }
    const inputPolicyError = enforcePathPolicy(input, "read");
    if (inputPolicyError) return inputPolicyError;
    if (output) {
      const outputPolicyError = enforcePathPolicy(output, "write");
      if (outputPolicyError) return outputPolicyError;
    }

    if (action === "info") {
      const result = safeExecFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input], { timeout: 15000 });
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "convert") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for convert" }], isError: true };
      if (options) throw new Error("Raw media options are no longer accepted; use typed actions such as resize, thumbnail, extract_audio, or trim");
      safeExecFileSync("ffmpeg", ["-y", "-i", input, output], { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
      return { content: [{ type: "text", text: `Converted: ${input} -> ${output}` }] };
    }

    if (action === "extract_audio") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for extract_audio" }], isError: true };
      if (options) throw new Error("Raw media options are no longer accepted for extract_audio");
      safeExecFileSync("ffmpeg", ["-y", "-i", input, "-vn", "-acodec", "libmp3lame", "-q:a", "2", output], { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
      return { content: [{ type: "text", text: `Extracted audio: ${input} -> ${output}` }] };
    }

    if (action === "thumbnail") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for thumbnail" }], isError: true };
      const time = validTimestamp(options, "00:00:01");
      safeExecFileSync("ffmpeg", ["-y", "-i", input, "-ss", time, "-vframes", "1", "-q:v", "2", output], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      return { content: [{ type: "text", text: `Thumbnail created: ${input} -> ${output}` }] };
    }

    if (action === "resize") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for resize" }], isError: true };
      const scale = validScale(options, "800:-1");
      safeExecFileSync("ffmpeg", ["-y", "-i", input, "-vf", `scale=${scale}`, output], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
      return { content: [{ type: "text", text: `Resized: ${input} -> ${output} (${scale})` }] };
    }

    if (action === "trim") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for trim" }], isError: true };
      const duration = validTimestamp(options, "00:00:10");
      safeExecFileSync("ffmpeg", ["-y", "-i", input, "-t", duration, output], { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
      return { content: [{ type: "text", text: `Trimmed: ${input} -> ${output}` }] };
    }

    return { content: [{ type: "text", text: "Error: unknown action. Use: info, convert, extract_audio, thumbnail, resize, trim" }], isError: true };
  } catch (e) {
    if (e.message.includes("not found") || e.message.includes("ENOENT")) {
      return { content: [{ type: "text", text: "Error: ffmpeg not installed. Run: sudo apt install ffmpeg" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_transcribe({ path: audioPath, model, language, async: runAsync, backend, device: requestedDevice, action = "submit", job_id: jobId }) {
  try {
    if (action === "status") {
      if (!jobId) return { content: [{ type: "text", text: "Error: job_id is required for status" }], isError: true };
      const job = loadTranscriptionJob(jobId);
      if (!job) return { content: [{ type: "text", text: `Error: transcription job not found: ${jobId}` }], isError: true };
      const { child, ...publicJob } = job;
      return { content: [{ type: "text", text: JSON.stringify(publicJob) }] };
    }
    if (action === "cancel") {
      if (!jobId) return { content: [{ type: "text", text: "Error: job_id is required for cancel" }], isError: true };
      const job = loadTranscriptionJob(jobId);
      if (!job) return { content: [{ type: "text", text: `Error: transcription job not found: ${jobId}` }], isError: true };
      if (job.child && !job.child.killed) job.child.kill("SIGTERM");
      finishTranscriptionJob(job, { status: "cancelled" });
      const { child, ...publicJob } = job;
      return { content: [{ type: "text", text: JSON.stringify(publicJob) }] };
    }
    if (!audioPath) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
    const policyError = enforcePathPolicy(audioPath, "read");
    if (policyError) return policyError;
    if (!fs.existsSync(audioPath)) {
      return { content: [{ type: "text", text: `Error: File not found: ${audioPath}` }], isError: true };
    }

    const m = validWhisperModel(model);
    const lang = language ? validLangCode(language, "eng") : undefined;
    const selected = selectTranscriptionBackend(backend);
    const device = selectTranscriptionDevice(selected.name, requestedDevice);
    if (runAsync) {
      const job = startTranscriptionJob({ audioPath, model: m, language: lang, backend, device });
      const { child, ...publicJob } = job;
      return { content: [{ type: "text", text: JSON.stringify(publicJob) }] };
    }
    const args = transcriptionArgs(selected.name, device, audioPath, m, lang, "/tmp");
    const result = safeExecFileSync(selected.command, args, { timeout: 600000, maxBuffer: 2 * 1024 * 1024 });

    const tmpTxtPath = selected.name === "whisper.cpp"
      ? "/tmp/transcript.txt"
      : `/tmp/${path.basename(audioPath).replace(/\.[^.]+$/, ".txt")}`;
    if (fs.existsSync(tmpTxtPath)) {
      const text = fs.readFileSync(tmpTxtPath, "utf-8").trim();
      fs.unlinkSync(tmpTxtPath);
      return { content: [{ type: "text", text: text || "(no speech detected)" }] };
    }

    return { content: [{ type: "text", text: result || "(no speech detected)" }] };
  } catch (e) {
    if (e.message.includes("not found") || e.message.includes("ENOENT")) {
      return { content: [{ type: "text", text: "Error: whisper not installed. Run: pip3 install openai-whisper" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_analytics({ query, file, format }) {
  try {
    const venvPath = "/home/sidekick/.sidekick-tools/bin/python3";
    const pythonCmd = fs.existsSync(venvPath) ? venvPath : "python3";

    // Helper: run Python script via temp file to avoid shell escaping issues
    const runPyScript = (pyScript) => {
      const tmpFile = path.join(os.tmpdir(), "sidekick_analytics_" + Date.now() + ".py");
      try {
        fs.writeFileSync(tmpFile, pyScript);
        return execFileSync(pythonCmd, [tmpFile], { timeout: 60000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: childProcessEnv() });
      } finally {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
      }
    };

    if (file) {
      const policyError = enforcePathPolicy(file, "read");
      if (policyError) return policyError;
      if (!fs.existsSync(file)) {
        return { content: [{ type: "text", text: "Error: File not found: " + file }], isError: true };
      }

      const sql = query || "SELECT * FROM data LIMIT 100";
      const fmt = format || "csv";
      // Pass all parameters via JSON to avoid escaping issues
      const params = JSON.stringify({ file, sql, fmt });
      const pyScript = `import duckdb, json, sys
params = json.loads(${JSON.stringify(params)})
con = duckdb.connect()
f = params["file"]
if params["fmt"] == "csv":
    con.execute(f"CREATE TABLE data AS SELECT * FROM read_csv_auto('{f}')")
elif params["fmt"] == "json":
    con.execute(f"CREATE TABLE data AS SELECT * FROM read_json_auto('{f}')")
elif params["fmt"] == "parquet":
    con.execute(f"CREATE TABLE data AS SELECT * FROM read_parquet('{f}')")
result = con.execute(params["sql"]).fetchdf()
print(result.to_string(index=False))
`;
      const result = runPyScript(pyScript);
      return { content: [{ type: "text", text: result }] };
    }

    if (query) {
      const params = JSON.stringify({ query });
      const pyScript = `import duckdb, json, sys
params = json.loads(${JSON.stringify(params)})
con = duckdb.connect()
result = con.execute(params["query"]).fetchdf()
print(result.to_string(index=False))
`;
      const result = runPyScript(pyScript);
      return { content: [{ type: "text", text: result }] };
    }

    return { content: [{ type: "text", text: "Error: query or file is required" }], isError: true };
  } catch (e) {
    if (e.message.includes("not found") || e.message.includes("ModuleNotFoundError")) {
      return { content: [{ type: "text", text: "Error: DuckDB not installed. Run: pip3 install duckdb" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Insight Report Tool ---

const INSIGHT_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".log", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".ini", ".csv", ".tsv"]);
const INSIGHT_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"]);
const INSIGHT_MAX_BYTES = 512 * 1024;

function normalizeInsightPaths(paths) {
  if (Array.isArray(paths)) return paths.map(String).map(s => s.trim()).filter(Boolean);
  return String(paths || "").split(",").map(s => s.trim()).filter(Boolean);
}

function inferInsightType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (INSIGHT_IMAGE_EXTENSIONS.has(ext)) return "image";
  if ([".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".ini"].includes(ext)) return "data";
  if (INSIGHT_TEXT_EXTENSIONS.has(ext)) return "text";
  return "unknown";
}

function readInsightTextFile(filePath) {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, INSIGHT_MAX_BYTES);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return {
      text: buffer.toString("utf-8").replace(/\0/g, ""),
      truncated: stat.size > INSIGHT_MAX_BYTES,
      bytes: stat.size
    };
  } finally {
    fs.closeSync(fd);
  }
}

function summarizeInsightText(text) {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.map(line => line.trim()).filter(Boolean);
  const errorLines = nonEmpty.filter(line => /\b(error|failed|exception|fatal|warn|timeout|denied)\b/i.test(line)).slice(0, 8);
  const counts = new Map();
  for (const line of nonEmpty) counts.set(line, (counts.get(line) || 0) + 1);
  const repeated = [...counts.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    lines: lines.length,
    nonEmpty: nonEmpty.length,
    sample: nonEmpty.slice(0, 6),
    errorLines,
    repeated
  };
}

function extractInsightTimeline(text) {
  const important = /\b(error|failed|exception|fatal|warn|timeout|denied|restart|started|listening|initialize|session|stale|replacement|invalid|deploy|crash|oom)\b/i;
  const timestamped = /^.*(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}).*$/;
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && timestamped.test(line) && important.test(line))
    .slice(0, 12);
}

function inferInsightAnalysis(evidenceItems) {
  const valid = evidenceItems.filter(item => !item.error);
  const allText = valid.map(item => [
    ...(item.sample || []),
    ...(item.errorLines || []),
    ...(item.timeline || []),
    item.ocrText || ""
  ].join("\n")).join("\n");
  const lower = allText.toLowerCase();
  const hasRestart = /\b(restart|systemctl restart|started|listening|deployment|deploy)\b/.test(lower);
  const hasStaleSession = /stale_session|stale session|invalid_session|invalid session|replacement session|replacementid|created_replacement_session/i.test(allText);
  const hasSuccessAfter = /reuse_session|session_initialized|created_new_transport|accepted|succeed|success/i.test(allText);
  const hasResourcePressure = /\b(oom|out of memory|disk full|no space|cpu|load average|killed process)\b/i.test(allText);
  const hasErrors = valid.some(item => item.errorLines?.length);

  let summary = "The supplied evidence was analyzed for timeline, failure signals, likely cause, and follow-up actions.";
  let rootCause = "No single root cause is proven by the supplied files. The strongest signals are the cited errors, warnings, repeated lines, and event ordering below.";
  let confidence = hasErrors ? "Medium" : "Low";
  const actions = [
    "Collect a narrower time window around the next occurrence, including service logs before and after the first failure.",
    "Add or verify log lines that include request/session identifiers, response status, and recovery outcome.",
    "Re-run this report with deployment logs, service logs, and any client-side error output together."
  ];

  if (hasRestart && hasStaleSession) {
    summary = "The intermittent failures align with clients reusing MCP session IDs that existed before a service restart.";
    rootCause = "The likely root cause is post-deployment session invalidation: restarting sidekick-mcp clears the in-memory session registry, while existing clients continue sending pre-restart session IDs. The server then returns an invalid-session response until the client adopts the replacement session or initializes a new one.";
    confidence = hasSuccessAfter ? "High" : "Medium-High";
    actions.splice(0, actions.length,
      "Verify clients reliably retry with the replacement session ID after invalid-session responses.",
      "Make deployment/restart workflows warn that active MCP sessions may be briefly invalidated.",
      "Consider graceful drain/restart behavior so active sessions finish before the MCP process exits.",
      "If seamless restarts are required, persist enough session metadata to recover or explicitly force client reinitialization.",
      "Track invalid-session responses as a deployment-adjacent metric so expected recovery can be distinguished from real outages."
    );
  } else if (hasResourcePressure) {
    summary = "The evidence contains resource-pressure indicators that may explain intermittent failures.";
    rootCause = "The likely root cause is resource exhaustion or process interruption, based on memory/disk/CPU/process-kill signals in the supplied evidence.";
    confidence = "Medium";
    actions.splice(0, actions.length,
      "Check host memory, disk, CPU, and service restart history for the failure window.",
      "Add alerts for the specific pressure signal seen in the evidence.",
      "Capture process logs and system journal entries immediately before the next failure."
    );
  }

  return { summary, rootCause, confidence, actions };
}

function summarizeInsightData(text, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const trimmed = text.trim();
  if ((ext === ".json" || trimmed.startsWith("{") || trimmed.startsWith("[")) && ext !== ".jsonl") {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const keys = [...new Set(parsed.slice(0, 50).flatMap(row => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []))];
      return { format: "json", rows: parsed.length, fields: keys.slice(0, 20), sample: parsed.slice(0, 3) };
    }
    return { format: "json", topLevelKeys: Object.keys(parsed || {}).slice(0, 20), sample: parsed };
  }
  if (ext === ".jsonl") {
    const rows = trimmed.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const keys = [...new Set(rows.slice(0, 50).flatMap(row => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []))];
    return { format: "jsonl", rows: rows.length, fields: keys.slice(0, 20), sample: rows.slice(0, 3) };
  }
  if (ext === ".csv" || ext === ".tsv" || detectFormat(text) === "csv") {
    const delimiter = ext === ".tsv" ? "\t" : ",";
    const rows = text.trim().split(/\r?\n/).filter(Boolean);
    const headers = rows[0] ? rows[0].split(delimiter).map(h => h.trim().replace(/^"(.*)"$/, "$1")) : [];
    return { format: ext === ".tsv" ? "tsv" : "csv", rows: Math.max(rows.length - 1, 0), columns: headers.length, fields: headers.slice(0, 20), sample: rows.slice(1, 4) };
  }
  if (ext === ".yaml" || ext === ".yml") {
    const parsed = YAML.parse(text);
    return { format: "yaml", topLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : [], sample: parsed };
  }
  if (ext === ".ini") {
    const parsed = INI.parse(text);
    return { format: "ini", topLevelKeys: Object.keys(parsed || {}).slice(0, 20), sample: parsed };
  }
  if (ext === ".xml") {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(text);
    return { format: "xml", topLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : [], sample: parsed };
  }
  return null;
}

function formatInsightValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "N/A";
  return text.length > 220 ? text.slice(0, 217) + "..." : text;
}

async function collectInsightEvidence(filePath) {
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return { path: filePath, error: policyError.content[0].text };
  if (!fs.existsSync(filePath)) return { path: filePath, error: "File not found" };

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { path: filePath, error: "Path is not a file" };

  const type = inferInsightType(filePath);
  const evidence = { path: filePath, type, bytes: stat.size, findings: [] };

  if (type === "image") {
    evidence.findings.push(`image file, ${stat.size} bytes`);
    const ocr = await sidekick_ocr({ path: filePath });
    if (ocr.isError) {
      evidence.findings.push("OCR unavailable: " + ocr.content[0].text.replace(/^Error:\s*/, ""));
    } else {
      const text = ocr.content[0].text.trim();
      evidence.ocrText = text;
      evidence.findings.push(text && text !== "(no text detected)" ? `OCR text: ${formatInsightValue(text)}` : "OCR found no text");
    }
    return evidence;
  }

  if (type === "unknown") {
    evidence.findings.push("unsupported file extension for deterministic inspection");
    return evidence;
  }

  const file = readInsightTextFile(filePath);
  evidence.truncated = file.truncated;
  const textSummary = summarizeInsightText(file.text);
  evidence.findings.push(`${textSummary.lines} lines, ${textSummary.nonEmpty} non-empty lines${file.truncated ? ", sampled first 512 KiB" : ""}`);

  if (type === "data") {
    try {
      const dataSummary = summarizeInsightData(file.text, filePath);
      if (dataSummary) {
        evidence.data = dataSummary;
        if (dataSummary.rows !== undefined) evidence.findings.push(`${dataSummary.format} data with ${dataSummary.rows} rows`);
        if (dataSummary.fields?.length) evidence.findings.push(`fields: ${dataSummary.fields.join(", ")}`);
        if (dataSummary.topLevelKeys?.length) evidence.findings.push(`top-level keys: ${dataSummary.topLevelKeys.join(", ")}`);
      }
    } catch (e) {
      evidence.findings.push("data parse failed: " + e.message);
    }
  }

  if (textSummary.errorLines.length) evidence.findings.push(`${textSummary.errorLines.length} error/warning-looking lines found`);
  if (textSummary.repeated.length) evidence.findings.push(`repeated lines: ${textSummary.repeated.map(([line, count]) => `${count}x ${formatInsightValue(line)}`).join("; ")}`);
  evidence.sample = textSummary.sample;
  evidence.errorLines = textSummary.errorLines;
  evidence.timeline = extractInsightTimeline(file.text);
  return evidence;
}

function formatInsightReport(evidenceItems, title) {
  const valid = evidenceItems.filter(item => !item.error);
  const errored = evidenceItems.filter(item => item.error);
  const analysis = inferInsightAnalysis(evidenceItems);
  const lines = [`# ${title || "Insight Report"}`, "", "## Summary"];
  lines.push(`- Analyzed ${valid.length} file(s); ${errored.length} file(s) had errors.`);
  const dataCount = valid.filter(item => item.type === "data").length;
  const imageCount = valid.filter(item => item.type === "image").length;
  const textCount = valid.filter(item => item.type === "text").length;
  lines.push(`- Inputs by type: ${textCount} text, ${dataCount} data, ${imageCount} image.`);
  lines.push(`- ${analysis.summary}`);

  const timeline = valid.flatMap(item => (item.timeline || []).map(event => ({ path: item.path, event })));
  if (timeline.length) {
    lines.push("", "## Timeline");
    for (const item of timeline.slice(0, 12)) lines.push(`- ${formatInsightValue(item.event)} [${item.path}]`);
  }

  lines.push("", "## Likely Root Cause");
  lines.push(`- ${analysis.rootCause}`);

  lines.push("", "## Confidence");
  lines.push(`- ${analysis.confidence}`);

  const notable = valid.flatMap(item => item.findings.map(finding => ({ path: item.path, finding })));
  if (notable.length) {
    lines.push("", "## Key Findings");
    for (const item of notable.slice(0, 12)) lines.push(`- ${item.finding} [${item.path}]`);
  }

  lines.push("", "## Evidence");
  for (const item of evidenceItems) {
    lines.push(`- ${item.path}`);
    if (item.error) {
      lines.push(`  Error: ${item.error}`);
      continue;
    }
    lines.push(`  Type: ${item.type}; Size: ${item.bytes} bytes`);
    if (item.sample?.length) lines.push(`  Sample: ${item.sample.map(formatInsightValue).join(" | ")}`);
    if (item.errorLines?.length) lines.push(`  Error evidence: ${item.errorLines.map(formatInsightValue).join(" | ")}`);
    if (item.data?.sample) lines.push(`  Data sample: ${formatInsightValue(item.data.sample)}`);
    if (item.ocrText) lines.push(`  OCR evidence: ${formatInsightValue(item.ocrText)}`);
  }

  lines.push("", "## Limits");
  lines.push(`- Text/data files are bounded to the first ${INSIGHT_MAX_BYTES} bytes.`);
  lines.push("- Analysis is deterministic and evidence-pattern based; it does not use an LLM or external context.");

  lines.push("", "## Next Actions");
  for (const action of analysis.actions) lines.push(`- ${action}`);
  return lines.join("\n");
}

async function sidekick_insight_report({ paths, title }) {
  try {
    const selectedPaths = normalizeInsightPaths(paths);
    if (selectedPaths.length === 0) {
      return { content: [{ type: "text", text: "Error: paths is required" }], isError: true };
    }
    if (selectedPaths.length > 10) {
      return { content: [{ type: "text", text: "Error: at most 10 paths are supported per report" }], isError: true };
    }
    const evidence = [];
    for (const filePath of selectedPaths) evidence.push(await collectInsightEvidence(filePath));
    return { content: [{ type: "text", text: formatInsightReport(evidence, title) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_download({ url, output, format, audio_only }) {
  try {
    if (!url) {
      return { content: [{ type: "text", text: "Error: url required" }], isError: true };
    }
    // Caller-supplied URL fetched from inside the trust boundary: apply the
    // same outbound destination policy as web_fetch (SSRF guard).
    const urlError = validateOutboundUrl(url, "url");
    if (urlError) {
      return { content: [{ type: "text", text: urlError }], isError: true };
    }
    const destination = await resolveOutboundUrl(url, "url");
    if (destination.refusal) {
      return { content: [{ type: "text", text: destination.refusal }], isError: true };
    }
    const parsedUrl = destination.url;
    const managedDownload = !output;
    const downloadDir = path.join(DATA_DIR, "downloads");
    if (managedDownload) fs.mkdirSync(downloadDir, { recursive: true, mode: 0o750 });
    const outputTarget = output || path.join(downloadDir, "%(title)s.%(ext)s");
    const outputPolicyError = enforcePathPolicy(outputTarget, "write");
    if (outputPolicyError) return outputPolicyError;

    const venvPath = "/home/sidekick/.sidekick-tools/bin/yt-dlp";
    const ytdlpCmd = fs.existsSync(venvPath) ? venvPath : "yt-dlp";

    const maxDownloadBytes = Math.max(1 * 1024 * 1024, Math.min(2 * 1024 * 1024 * 1024, Number(process.env.SIDEKICK_MAX_DOWNLOAD_BYTES) || 512 * 1024 * 1024));
    const args = [
      "--no-playlist",
      "--no-cache-dir",
      "--no-call-home",
      "--restrict-filenames",
      "--socket-timeout", "30",
      "--max-filesize", `${Math.floor(maxDownloadBytes / (1024 * 1024))}M`,
      "--print", "after_move:filepath",
    ];
    if (audio_only) {
      args.push("-x", "--audio-format", "mp3");
    } else if (format) {
      args.push("-f", validDownloadFormat(format));
    }
    args.push("--paths", `temp:${path.dirname(outputTarget)}`, "-o", outputTarget, parsedUrl.href);
    const result = safeExecFileSync(ytdlpCmd, args, { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });

    // Prefer yt-dlp's post-move path, but retain the legacy destination line
    // for older versions. Revalidate the actual path before reading or
    // registering it: downloader output is untrusted subprocess output.
    const outputMatch = result.match(/\[download\] Destination: (.+)/);
    const printedPaths = result.split(/\r?\n/).map(line => line.trim()).filter(line => line && fs.existsSync(line));
    const downloadedFile = printedPaths[printedPaths.length - 1] || (outputMatch ? outputMatch[1].trim() : null);

    if (!downloadedFile || !fs.existsSync(downloadedFile)) {
      throw new Error("yt-dlp did not produce a verifiable output file");
    }
    const canonicalFile = fs.realpathSync(downloadedFile);
    const downloadedPolicyError = enforcePathPolicy(canonicalFile, "write");
    if (downloadedPolicyError) return downloadedPolicyError;
    const stat = fs.statSync(canonicalFile);
    if (!stat.isFile()) throw new Error("yt-dlp output is not a regular file");
    if (stat.size > maxDownloadBytes) {
      try { fs.unlinkSync(canonicalFile); } catch {}
      throw new Error(`download exceeds the ${maxDownloadBytes}-byte limit`);
    }

    let artifact = null;
    if (managedDownload) {
      const bytes = fs.readFileSync(canonicalFile);
      const storageRef = path.relative(DATA_DIR, canonicalFile).split(path.sep).join("/");
      artifact = platformKernel.registerArtifact({
        type: "media_download",
        name: path.basename(canonicalFile),
        producer: "download",
        storage_ref: storageRef,
        content_type: mediaContentType(canonicalFile, audio_only),
        byte_size: bytes.length,
        content_hash: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
        redaction_state: "not_required",
        verification: { verified: true, method: "sha256", source_url: url },
        metadata: { source_url: url, audio_only: Boolean(audio_only) },
      });
    }

    return { content: [{ type: "text", text: JSON.stringify({
      status: "success",
      url: url,
      output: canonicalFile,
      ...(artifact ? { artifact_id: artifact.artifact_id, storage_ref: artifact.storage_ref } : {}),
      log: result.substring(0, 500)
    }, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

const SCHEMAS = {
  ocr: z.object({
    path: z.string().describe("Image file path"),
    language: z.string().optional().default("eng").describe("OCR language (default: eng)"),
    psm: z.number().optional().describe("Page segmentation mode")
  }),
  media: z.object({
    action: z.enum(["info", "convert", "extract_audio", "thumbnail", "resize", "trim"]).describe("Media action"),
    input: z.string().describe("Input file path"),
    output: z.string().optional().describe("Output file path"),
    options: z.string().optional().describe("Format-specific options")
  }),
  transcribe: z.object({
    path: z.string().optional().describe("Audio/video file path (required for submit)"),
    model: z.string().optional().default("base").describe("Whisper model (tiny|base|small|medium)"),
    language: z.string().optional().describe("Language code"),
    async: z.boolean().optional().default(false).describe("Return a persistent job ID instead of waiting for completion"),
    action: z.enum(["submit", "status", "cancel"]).optional().default("submit").describe("Transcription job action"),
    job_id: z.string().optional().describe("Job ID for status or cancel"),
    backend: z.enum(["auto", "faster-whisper", "whisper.cpp", "whisper"]).optional().default("auto").describe("Transcription backend; auto prefers optimized installed backends"),
    device: z.enum(["auto", "cpu", "cuda", "metal", "vulkan"]).optional().default("auto").describe("Local inference device; Vulkan supports compatible AMD/Intel/NVIDIA backends")
  }),
  analytics: z.object({
    query: z.string().optional().describe("SQL query"),
    file: z.string().optional().describe("Data file path (CSV, JSON, or Parquet)"),
    format: z.string().optional().describe("File format (csv|json|parquet)")
  }),
  insight_report: z.object({
    paths: z.union([z.string(), z.array(z.string())]).describe("Text, data, or image file path(s) to analyze"),
    title: z.string().optional().describe("Optional report title")
  }),
  download: z.object({
    url: z.string().describe("Video URL"),
    output: z.string().optional().describe("Output path"),
    format: z.string().optional().describe("Video format"),
    audio_only: z.boolean().optional().describe("Extract audio only")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "ocr",
    description: "Extract text from images using Tesseract OCR",
    schema: SCHEMAS.ocr,
    args: { path: "string (image file path)", language: "string (optional, language code - default eng)", psm: "number (optional, page segmentation mode)" },
    risk: "medium",
    category: "Media",
    source: "builtin",
    family: "media",
    handler: sidekick_ocr,
  }),
  Object.freeze({
    name: "media",
    description: "Media processing with ffmpeg: convert, extract audio, thumbnails, resize, trim, info",
    schema: SCHEMAS.media,
    args: { action: "string (info|convert|extract_audio|thumbnail|resize|trim)", input: "string (input file path)", output: "string (optional, output file path)", options: "string (optional, format-specific options)" },
    risk: "medium",
    category: "Media",
    source: "builtin",
    family: "media",
    handler: sidekick_media,
  }),
  Object.freeze({
    name: "transcribe",
    description: "Transcribe audio/video using a bounded asynchronous job or synchronous Whisper-compatible backend",
    schema: SCHEMAS.transcribe,
    args: { path: "string (audio/video file path; required for submit)", model: "string (optional, tiny|base|small|medium - default base)", language: "string (optional, language code)", async: "boolean (optional; return job ID)", action: "string (submit|status|cancel)", job_id: "string (status/cancel)", backend: "string (auto|faster-whisper|whisper.cpp|whisper)", device: "string (auto|cpu|cuda|metal|vulkan)" },
    risk: "medium",
    category: "Media",
    source: "builtin",
    family: "media",
    handler: sidekick_transcribe,
  }),
  Object.freeze({
    name: "analytics",
    description: "Fast analytical queries on CSV/JSON/Parquet files using DuckDB",
    schema: SCHEMAS.analytics,
    args: { query: "string (SQL query)", file: "string (optional, data file path - CSV, JSON, or Parquet)", format: "string (optional, file format: csv|json|parquet - auto-detected)" },
    risk: "medium",
    category: "Database",
    source: "builtin",
    family: "media",
    handler: sidekick_analytics,
  }),
  Object.freeze({
    name: "insight_report",
    description: "Create a concise, evidence-backed report from text, data, or image file paths",
    schema: SCHEMAS.insight_report,
    args: { paths: "string|array (file path, comma-separated paths, or array of paths)", title: "string (optional report title)" },
    risk: "low",
    category: "Data Pipeline",
    source: "builtin",
    family: "media",
    handler: sidekick_insight_report,
  }),
  Object.freeze({
    name: "download",
    description: "Download videos/audio from YouTube and 1000+ sites using yt-dlp",
    schema: SCHEMAS.download,
    args: { url: "string (video URL)", output: "string (optional, output path)", format: "string (optional, video format)", audio_only: "boolean (optional, extract audio only)" },
    risk: "medium",
    category: "Media",
    source: "builtin",
    family: "media",
    handler: sidekick_download,
  }),
]);

module.exports = { descriptors, sidekick_ocr, sidekick_media, sidekick_transcribe, sidekick_analytics, sidekick_insight_report, sidekick_download };
