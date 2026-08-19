"use strict";

const fs = require("fs");
const { execFileSync, execSync } = require("child_process");
const { z } = require("zod");
const dbStore = require("../../db");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");
const { childProcessEnv } = require("../../security/child-process");

function safeExecFileSync(program, args, options = {}) {
  return execFileSync(program, args, { ...options, env: childProcessEnv(options.env) });
}

async function sidekick_tail({ source, pattern, lines, since }) {
  const maxLines = lines || 50;
  const re = pattern ? new RegExp(pattern, "i") : null;
  let content;
  if (source === "log.jsonl" || source === "log") {
    let parsed = dbStore.readToolLogs(1000);
    let filtered = parsed;
    if (since) {
      const sinceDate = new Date(since).getTime();
      filtered = parsed.filter(l => new Date(l.t).getTime() >= sinceDate);
    }
    if (re) {
      filtered = filtered.filter(l => re.test(l.n) || re.test(l.s) || re.test(l.a));
    }
    content = filtered.slice(-maxLines).map(l =>
      l.t.slice(11, 19) + " [" + (l.ok ? "OK" : "ERR") + "] " + l.n + ": " + l.s
    ).join("\n");
  } else if (source === "journalctl") {
    try {
      const svc = pattern || "sidekick-mcp";
      const stdout = safeExecFileSync("journalctl", ["-u", svc, "-n", String(maxLines), "--no-pager"], {
        timeout: 10000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024
      });
      content = stdout;
    } catch (e) {
      content = e.stdout || e.message;
    }
  } else {
    const policyError = enforcePathPolicy(source, "read");
    if (policyError) return policyError;
    if (!fs.existsSync(source)) {
      return { content: [{ type: "text", text: "File not found: " + source }], isError: true };
    }
    const allLines = fs.readFileSync(source, "utf-8").split("\n");
    let filtered = allLines;
    if (re) filtered = allLines.filter(l => re.test(l));
    content = filtered.slice(-maxLines).join("\n");
  }
  return { content: [{ type: "text", text: redactSensitive(content || "(no matching entries)") }] };
}

const path = require("path");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "..", "data");

const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
if (!fs.existsSync(SNAPSHOTS_DIR)) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

function captureProcesses() {
  try {
    const output = safeExecFileSync("ps", ["aux", "--sort=-%mem"], { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    return lines.slice(1).map(line => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1]),
        cpu: parseFloat(parts[2]),
        mem: parseFloat(parts[3]),
        command: parts.slice(10).join(" ")
      };
    });
  } catch {
    return [];
  }
}

function captureServices() {
  try {
    const output = safeExecFileSync("systemctl", ["list-units", "--type=service", "--state=running", "--no-pager"], { encoding: "utf-8" });
    const lines = output.trim().split("\n").slice(1, -5);
    return lines.map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        unit: parts[0],
        load: parts[1],
        active: parts[2],
        sub: parts[3],
        description: parts.slice(4).join(" ")
      };
    });
  } catch {
    return [];
  }
}

function captureDisk() {
  try {
    const output = safeExecFileSync("df", ["-h", "--output=source,size,used,avail,pcent,target"], { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    return lines.slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        usePercent: parts[4],
        mounted: parts[5]
      };
    });
  } catch {
    return [];
  }
}

function captureFiles(filePaths) {
  if (!filePaths) return {};
  const paths = filePaths.split(",").map(p => p.trim());
  const result = {};
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      result[p] = { mtime: Math.floor(stat.mtimeMs / 1000), size: stat.size };
    } catch {
      result[p] = { error: "not found" };
    }
  }
  return result;
}

function capturePackages() {
  try {
    const output = safeExecFileSync("dpkg-query", ["-W", "-f=${Package} ${Version}\n"], { encoding: "utf-8" });
    return output.trim().split("\n").map(line => {
      const [name, version] = line.split(" ");
      return { name, version };
    });
  } catch {
    return [];
  }
}

function captureNetwork() {
  try {
    const interfaces = safeExecFileSync("ip", ["-o", "link", "show"], { encoding: "utf-8" }).trim().split("\n").map(line => line.split(":")[1]?.trim()).filter(Boolean);
    const result = {};
    for (const iface of interfaces) {
      try {
      const output = safeExecFileSync("ip", ["-o", "-4", "addr", "show", iface], { encoding: "utf-8" }).trim();
        const ip = output.match(/\binet\s+(\S+)/)?.[1] || "none";
        result[iface] = { ip };
      } catch {
        result[iface] = { ip: "none" };
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function sidekick_snapshot({ action, name, capture, compare }) {
  const now = new Date().toISOString();

  if (action === "capture") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }

    const types = capture ? capture.split(",").map(t => t.trim()) : ["processes", "services", "disk"];
    const snapshot = { name, date: now, types, data: {} };

    for (const type of types) {
      if (type === "processes") {
        snapshot.data.processes = captureProcesses();
      } else if (type === "services") {
        snapshot.data.services = captureServices();
      } else if (type === "disk") {
        snapshot.data.disk = captureDisk();
      } else if (type === "packages") {
        snapshot.data.packages = capturePackages();
      } else if (type === "network") {
        snapshot.data.network = captureNetwork();
      } else if (type.startsWith("files:")) {
        const paths = type.substring(6);
        for (const filePath of paths.split(",").map(p => p.trim()).filter(Boolean)) {
          const policyError = enforcePathPolicy(filePath, "read");
          if (policyError) return policyError;
        }
        snapshot.data.files = captureFiles(paths);
      }
    }

    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

    return { content: [{ type: "text", text: `Captured snapshot: ${name}\nTypes: ${types.join(", ")}\nDate: ${now}` }] };
  }

  if (action === "compare") {
    if (!name || !compare) {
      return { content: [{ type: "text", text: "name and compare required" }], isError: true };
    }

    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    const comparePath = path.join(SNAPSHOTS_DIR, `${compare}.json`);

    if (!fs.existsSync(snapshotPath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${name}` }], isError: true };
    }
    if (!fs.existsSync(comparePath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${compare}` }], isError: true };
    }

    const current = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    const baseline = JSON.parse(fs.readFileSync(comparePath, "utf-8"));

    let output = `# Snapshot Comparison\n\n`;
    output += `**Current: ${name}** (${current.date})\n`;
    output += `**Baseline: ${compare}** (${baseline.date})\n\n`;

    const diff = { added: [], removed: [], changed: [] };

    if (current.data.processes && baseline.data.processes) {
      const currentPids = new Set(current.data.processes.map(p => p.pid));
      const baselinePids = new Set(baseline.data.processes.map(p => p.pid));

      for (const p of current.data.processes) {
        if (!baselinePids.has(p.pid)) diff.added.push(`Process: ${p.command} (PID ${p.pid})`);
      }
      for (const p of baseline.data.processes) {
        if (!currentPids.has(p.pid)) diff.removed.push(`Process: ${p.command} (PID ${p.pid})`);
      }
    }

    if (current.data.services && baseline.data.services) {
      const currentServices = new Set(current.data.services.map(s => s.unit));
      const baselineServices = new Set(baseline.data.services.map(s => s.unit));

      for (const s of current.data.services) {
        if (!baselineServices.has(s.unit)) diff.added.push(`Service: ${s.unit}`);
      }
      for (const s of baseline.data.services) {
        if (!currentServices.has(s.unit)) diff.removed.push(`Service: ${s.unit}`);
      }
    }

    if (current.data.files && baseline.data.files) {
      for (const [path, info] of Object.entries(current.data.files)) {
        const baselineInfo = baseline.data.files[path];
        if (!baselineInfo) {
          diff.added.push(`File: ${path}`);
        } else if (info.mtime !== baselineInfo.mtime || info.size !== baselineInfo.size) {
          diff.changed.push(`File: ${path} (modified)`);
        }
      }
      for (const path of Object.keys(baseline.data.files)) {
        if (!current.data.files[path]) {
          diff.removed.push(`File: ${path}`);
        }
      }
    }

    output += `## Summary\n`;
    output += `- Added: ${diff.added.length}\n`;
    output += `- Removed: ${diff.removed.length}\n`;
    output += `- Changed: ${diff.changed.length}\n\n`;

    if (diff.added.length > 0) {
      output += `## Added\n`;
      for (const item of diff.added.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.added.length > 20) output += `- ... and ${diff.added.length - 20} more\n`;
      output += `\n`;
    }

    if (diff.removed.length > 0) {
      output += `## Removed\n`;
      for (const item of diff.removed.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.removed.length > 20) output += `- ... and ${diff.removed.length - 20} more\n`;
      output += `\n`;
    }

    if (diff.changed.length > 0) {
      output += `## Changed\n`;
      for (const item of diff.changed.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.changed.length > 20) output += `- ... and ${diff.changed.length - 20} more\n`;
      output += `\n`;
    }

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "list") {
    const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith(".json"));
    const snapshots = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), "utf-8"));
      return { name: data.name, date: data.date, types: data.types.join(", ") };
    });

    let output = `# Snapshots (${snapshots.length})\n\n`;
    for (const s of snapshots) {
      output += `- **${s.name}** (${s.date})\n  Types: ${s.types}\n`;
    }

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "delete") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }

    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    if (!fs.existsSync(snapshotPath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${name}` }], isError: true };
    }

    fs.unlinkSync(snapshotPath);
    return { content: [{ type: "text", text: `Deleted snapshot: ${name}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: capture, compare, list, delete" }], isError: true };
}

const MAX_TIMELINE_EVENTS = 500;
const MAX_TIMELINE_RANGE_DAYS = 30;

function parseRelativeTime(str) {
  if (!str || str === "now") return new Date();
  const match = str.match(/^(\d+)([smhd])$/);
  if (match) {
    const val = parseInt(match[1]);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(Date.now() - val * multipliers[unit]);
  }
  return new Date(str);
}

function parseJournalctlLine(line) {
  const match = line.match(/^(\S+ \d+ \d+:\d+:\d+) (\S+) (.+)$/);
  if (!match) return null;
  const [_, timestamp, host, message] = match;
  const year = new Date().getFullYear();
  const date = new Date(`${year} ${timestamp}`);
  const severity = /error|fail|critical/i.test(message) ? "error"
    : /warn/i.test(message) ? "warn" : "info";
  return { timestamp: date.toISOString(), source: "journalctl", severity, summary: message.substring(0, 200) };
}

function parseGitLogLine(line) {
  const match = line.match(/^(\S+)\t(.+?)\t(.+)$/);
  if (!match) return null;
  const [_, hash, date, message] = match;
  return {
    timestamp: new Date(date).toISOString(),
    source: "git",
    severity: "info",
    summary: `${hash.substring(0, 7)}: ${message.substring(0, 150)}`
  };
}

function findRecentFiles(root, startTime, limit = 50) {
  const results = [];
  function walk(dir) {
    if (results.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && stat.mtime >= startTime) results.push({ file: fullPath, stat });
    }
  }
  walk(root);
  return results;
}

async function sidekick_timeline({ action, since, until, sources, pattern, severity, format, max_events }) {
  const maxEvents = max_events || MAX_TIMELINE_EVENTS;
  const startTime = parseRelativeTime(since);
  const endTime = parseRelativeTime(until || "now");

  const rangeDays = (endTime - startTime) / 86400000;
  if (rangeDays > MAX_TIMELINE_RANGE_DAYS) {
    return { content: [{ type: "text", text: `Time range exceeds maximum of ${MAX_TIMELINE_RANGE_DAYS} days` }], isError: true };
  }

  const useSources = sources && sources[0] !== "all" ? sources : ["log.jsonl", "journalctl", "git", "files"];
  const events = [];

  if (useSources.includes("log.jsonl")) {
    try {
      const toolLogs = dbStore.readToolLogs(1000);
      for (const log of toolLogs) {
        const event = {
          timestamp: log.t,
          source: "log.jsonl",
          tool: log.n,
          status: log.ok ? "success" : "error",
          summary: log.s,
          args: log.a
        };
        const eventTime = new Date(event.timestamp);
        if (eventTime >= startTime && eventTime <= endTime) {
          events.push(event);
        }
      }
    } catch {}
  }

  if (useSources.includes("journalctl")) {
    try {
      const sinceStr = startTime.toISOString();
      const result = safeExecFileSync("journalctl", ["--since", sinceStr, "--no-pager", "-n", "500"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const lines = result.trim().split("\n").slice(4);
      for (const line of lines) {
        const event = parseJournalctlLine(line);
        if (event) {
          const eventTime = new Date(event.timestamp);
          if (eventTime >= startTime && eventTime <= endTime) {
            events.push(event);
          }
        }
      }
    } catch {}
  }

  if (useSources.includes("git")) {
    try {
      const sinceDate = startTime.toISOString();
      const result = safeExecFileSync("git", ["log", `--since=${sinceDate}`, "--pretty=format:%H%x09%ad%x09%s", "--date=iso", "-n", "100"], {
        encoding: "utf8",
        timeout: 10000,
        cwd: "/home/sidekick/sidekick",
        stdio: ["pipe", "pipe", "pipe"]
      });
      const lines = result.trim().split("\n");
      for (const line of lines) {
        const event = parseGitLogLine(line);
        if (event) events.push(event);
      }
    } catch {}
  }

  if (useSources.includes("files")) {
    try {
      for (const { file, stat } of findRecentFiles("/home/sidekick/sidekick", startTime, 50)) {
        events.push({
          timestamp: stat.mtime.toISOString(),
          source: "files",
          severity: "info",
          summary: `Modified: ${file}`
        });
      }
    } catch {}
  }

  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let filtered = events;
  if (severity && severity !== "all") {
    filtered = filtered.filter(e => e.severity === severity);
  }
  if (pattern) {
    const regex = new RegExp(pattern, "i");
    filtered = filtered.filter(e => regex.test(e.summary));
  }

  if (filtered.length > maxEvents) {
    filtered = filtered.slice(0, maxEvents);
  }

  if (action === "filter") {
    return { content: [{ type: "text", text: `Found ${filtered.length} events matching filters` }] };
  }

  if (action === "export" && format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
  }

  if (filtered.length === 0) {
    return { content: [{ type: "text", text: `No events found between ${since} and ${until || "now"}` }] };
  }

  let output = `Timeline: ${startTime.toISOString()} to ${endTime.toISOString()}\n`;
  output += `Events: ${filtered.length}\n\n`;

  if (format === "detailed") {
    for (const event of filtered) {
      output += `[${event.timestamp}] [${event.source}] [${event.severity}]\n  ${event.summary}\n\n`;
    }
  } else {
    for (const event of filtered) {
      const time = event.timestamp.substring(11, 19);
      output += `${time} [${event.source.padEnd(10)}] ${event.summary}\n`;
    }
  }

  return { content: [{ type: "text", text: output }] };
}

const BASELINE_FILE = path.join(DATA_DIR, "baselines.json");
const MAX_TRACKED_METRICS = 50;
const MAX_DATA_POINTS_PER_METRIC = 1000;
const MIN_DATA_POINTS_FOR_LEARNING = 10;

function loadBaselines() {
  try {
    if (fs.existsSync(BASELINE_FILE)) {
      return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    }
  } catch {}
  return { metrics: {} };
}

function saveBaselines(data) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
}

function getTimeBucket(hour) {
  return Math.floor(hour / 4) * 4;
}

function calculateStats(values) {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  return { mean, stddev };
}

async function sidekick_baseline({ action, metric_name, value, source, command, window, sensitivity }) {
  const data = loadBaselines();
  const sens = sensitivity || "medium";
  const sigmaMultiplier = { low: 3, medium: 2, high: 1.5 }[sens] || 2;

  if (action === "record") {
    if (!metric_name || value === undefined) {
      return { content: [{ type: "text", text: "metric_name and value required" }], isError: true };
    }

    if (!data.metrics[metric_name]) {
      if (Object.keys(data.metrics).length >= MAX_TRACKED_METRICS) {
        return { content: [{ type: "text", text: `Max metrics reached (${MAX_TRACKED_METRICS})` }], isError: true };
      }
      data.metrics[metric_name] = {
        dataPoints: [],
        baseline: null,
        created: Date.now()
      };
    }

    const metric = data.metrics[metric_name];
    metric.dataPoints.push({
      value,
      timestamp: Date.now(),
      hour: new Date().getHours()
    });

    if (metric.dataPoints.length > MAX_DATA_POINTS_PER_METRIC) {
      metric.dataPoints = metric.dataPoints.slice(-MAX_DATA_POINTS_PER_METRIC);
    }

    saveBaselines(data);
    return { content: [{ type: "text", text: `Recorded ${value} for ${metric_name} (${metric.dataPoints.length} points total)` }] };
  }

  if (action === "learn") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }

    const metric = data.metrics[metric_name];
    if (!metric) {
      return { content: [{ type: "text", text: `Metric not found: ${metric_name}` }], isError: true };
    }

    if (metric.dataPoints.length < MIN_DATA_POINTS_FOR_LEARNING) {
      return { content: [{ type: "text", text: `Insufficient data: ${metric.dataPoints.length}/${MIN_DATA_POINTS_FOR_LEARNING} points needed` }], isError: true };
    }

    const buckets = {};
    for (const point of metric.dataPoints) {
      const bucket = getTimeBucket(point.hour);
      if (!buckets[bucket]) buckets[bucket] = [];
      buckets[bucket].push(point.value);
    }

    const baseline = {};
    for (const [bucket, values] of Object.entries(buckets)) {
      const stats = calculateStats(values);
      baseline[bucket] = {
        mean: stats.mean,
        stddev: stats.stddev,
        count: values.length
      };
    }

    metric.baseline = baseline;
    metric.learnedAt = Date.now();
    saveBaselines(data);

    const bucketSummary = Object.entries(baseline).map(([b, s]) =>
      `${b.toString().padStart(2, "0")}:00 - mean: ${s.mean.toFixed(2)}, σ: ${s.stddev.toFixed(2)} (n=${s.count})`
    ).join("\n");

    return { content: [{ type: "text", text: `Baseline learned for ${metric_name}\n\nTime buckets:\n${bucketSummary}` }] };
  }

  if (action === "check") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }

    let currentValue = value;
    if (currentValue === undefined && source === "command" && command) {
      try {
        const result = execSync(command, { encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], env: childProcessEnv() });
        currentValue = parseFloat(result.trim());
      } catch (e) {
        return { content: [{ type: "text", text: `Command failed: ${e.message}` }], isError: true };
      }
    }

    if (currentValue === undefined || isNaN(currentValue)) {
      return { content: [{ type: "text", text: "value required (or use source=command with a command that outputs a number)" }], isError: true };
    }

    const metric = data.metrics[metric_name];
    if (!metric || !metric.baseline) {
      return { content: [{ type: "text", text: `No baseline for ${metric_name}. Use action=learn first.` }], isError: true };
    }

    const currentHour = new Date().getHours();
    const bucket = getTimeBucket(currentHour);
    const bucketStats = metric.baseline[bucket];

    if (!bucketStats) {
      return { content: [{ type: "text", text: `No baseline data for time bucket ${bucket}:00` }], isError: true };
    }

    const deviation = Math.abs(currentValue - bucketStats.mean);
    const sigmaDeviation = bucketStats.stddev > 0 ? deviation / bucketStats.stddev : 0;
    const isAnomaly = sigmaDeviation > sigmaMultiplier;

    const result = {
      metric: metric_name,
      current: currentValue,
      expected: bucketStats.mean.toFixed(2),
      deviation: sigmaDeviation.toFixed(2) + "σ",
      threshold: sigmaMultiplier + "σ",
      status: isAnomaly ? "ANOMALY" : "normal",
      timeBucket: `${bucket}:00-${bucket + 3}:59`
    };

    let output = `Baseline Check: ${metric_name}\n`;
    output += `Current: ${result.current}\n`;
    output += `Expected: ${result.expected} (±${bucketStats.stddev.toFixed(2)}σ)\n`;
    output += `Deviation: ${result.deviation} (threshold: ${result.threshold})\n`;
    output += `Time bucket: ${result.timeBucket}\n`;
    output += `Status: ${result.status}`;

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "status") {
    const entries = Object.entries(data.metrics);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No metrics tracked" }] };
    }
    const list = entries.map(([name, m]) => {
      const learned = m.baseline ? "✓" : "✗";
      return `${name}: ${m.dataPoints.length} points, baseline: ${learned}`;
    }).join("\n");
    return { content: [{ type: "text", text: `Tracked metrics (${entries.length}/${MAX_TRACKED_METRICS}):\n\n${list}` }] };
  }

  if (action === "reset") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }
    if (data.metrics[metric_name]) {
      delete data.metrics[metric_name];
      saveBaselines(data);
      return { content: [{ type: "text", text: `Reset metric: ${metric_name}` }] };
    }
    return { content: [{ type: "text", text: `Metric not found: ${metric_name}` }], isError: true };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: record, learn, check, status, reset" }], isError: true };
}

const EXTRA_SCHEMAS = {
  snapshot: z.object({
    action: z.enum(["capture", "compare", "list", "delete"]).describe("Snapshot action: capture (save state), compare (detect drift), list (show all), delete (remove)"),
    name: z.string().optional().describe("Snapshot name"),
    capture: z.string().optional().describe("What to capture: processes,services,disk,packages,network,files:/path (comma-separated)"),
    compare: z.string().optional().describe("Baseline snapshot name for compare action")
  }),
  timeline: z.object({
    action: z.enum(["build", "filter", "export"]),
    since: z.string().describe("Start time (ISO or relative: 1h, 1d, 7d)"),
    until: z.string().optional().default("now"),
    sources: z.array(z.enum(["log.jsonl", "journalctl", "git", "files", "all"])).optional().default(["all"]),
    pattern: z.string().optional().describe("Regex filter for event content"),
    severity: z.enum(["error", "warn", "info", "all"]).optional().default("all"),
    format: z.enum(["compact", "detailed", "json"]).optional().default("compact"),
    max_events: z.number().optional().default(200)
  }),
  baseline: z.object({
    action: z.enum(["record", "learn", "check", "status", "reset"]),
    metric_name: z.string().describe("Metric identifier"),
    value: z.number().optional().describe("Value to record (for action=record)"),
    source: z.string().optional().describe("Data source: 'health', 'custom', 'command'"),
    command: z.string().optional().describe("Command to collect metric (for source=command)"),
    window: z.string().optional().default("7d").describe("History window to analyze"),
    sensitivity: z.enum(["low", "medium", "high"]).optional().default("medium")
  }),
};
const descriptors = Object.freeze([
  Object.freeze({
    name: "tail",
    description: "Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file.",
    schema: z.object({
      source: z.string().describe("Source: log.jsonl, journalctl, or file path"),
      pattern: z.string().optional().describe("Regex filter (for journalctl: service name)"),
      lines: z.number().optional().describe("Number of lines to return (default: 50)"),
      since: z.string().optional().describe("Filter entries since this date (ISO date or relative: 1h, 1d)"),
    }),
    args: { source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" },
    risk: "medium",
    category: "Efficiency",
    source: "builtin",
    family: "monitoring",
    handler: sidekick_tail,
  }),
  Object.freeze({
    name: "snapshot",
    description: "Capture system state and detect drift by comparing snapshots",
    schema: EXTRA_SCHEMAS.snapshot,
    args: { action: "string (capture|compare|list|delete)", name: "string (snapshot name)", capture: "string (optional, comma-separated: processes,services,disk,packages,network,files:/path)", compare: "string (optional, baseline snapshot name for compare action)" },
    risk: "medium",
    category: "Monitoring",
    source: "builtin",
    family: "monitoring",
    handler: sidekick_snapshot,
  }),
  Object.freeze({
    name: "timeline",
    description: "Build chronological timeline from multiple log sources. Correlates events across log.jsonl, journalctl, git, and file modifications.",
    schema: EXTRA_SCHEMAS.timeline,
    args: { action: "string (build|filter|export)", since: "string (start time: ISO or relative like 1h, 1d)", until: "string (optional, end time - default now)", sources: "array (optional, log.jsonl|journalctl|git|files|all - default all)", pattern: "string (optional, regex filter)", severity: "string (optional, error|warn|info|all - default all)", format: "string (optional, compact|detailed|json - default compact)", max_events: "number (optional, default 200)" },
    risk: "medium",
    category: "Monitoring",
    source: "builtin",
    family: "monitoring",
    handler: sidekick_timeline,
  }),
  Object.freeze({
    name: "baseline",
    description: "Behavioral baseline and anomaly detection. Learns normal patterns and detects statistical deviations.",
    schema: EXTRA_SCHEMAS.baseline,
    args: { action: "string (record|learn|check|status|reset)", metric_name: "string (metric identifier)", value: "number (optional, value to record)", source: "string (optional, health|custom|command)", command: "string (optional, command to collect metric)", window: "string (optional, history window - default 7d)", sensitivity: "string (optional, low|medium|high - default medium)" },
    risk: "high",
    category: "Monitoring",
    source: "builtin",
    family: "monitoring",
    handler: sidekick_baseline,
  }),
]);

module.exports = { descriptors, sidekick_tail, sidekick_snapshot, sidekick_timeline, sidekick_baseline };
