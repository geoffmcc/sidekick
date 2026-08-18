"use strict";

// Observability tool family: status, health, metrics, netdiag.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins and zod —
// never on tools-legacy.js; the platform-module repository/loader are required
// lazily inside the module checks, exactly as before. `health` and `netdiag`
// are `high` risk (custom health commands run through a shell; netdiag builds
// shell command strings), preserved from src/tools/metadata.js and gated by
// the dispatcher. netdiag interpolates every user-supplied value through
// shellEscape before the string reaches execSync; that escaping is moved
// verbatim. checkNetwork keeps its injectable probe seams
// ({dnsProbe, httpsProbe, execFileSyncImpl}) for test/health.test.js and is
// re-exported through the src/tools facade as a compatibility export.

const fs = require("fs");
const path = require("path");
const dns = require("dns");
const https = require("https");
const { execFileSync, execSync } = require("child_process");
const { z } = require("zod");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const SHELL_META = /[`$\\!#&|;()*?<>[\]{}"'\n\r]/;
function shellEscape(arg) {
  if (arg === "") return "''";
  if (!SHELL_META.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

const HEALTH_HISTORY_FILE = path.join(DATA_DIR, "health_history.json");
const MAX_HEALTH_HISTORY = 100;

function loadHealthHistory() {
  if (!fs.existsSync(HEALTH_HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HEALTH_HISTORY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveHealthHistory(history) {
  fs.writeFileSync(HEALTH_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function checkServices(serviceList) {
  const services = serviceList
    ? serviceList.split(",").map(s => s.trim()).filter(Boolean)
    : ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"];
  const results = [];
  let healthy = 0;
  for (const svc of services) {
    try {
      const output = execFileSync("systemctl", ["is-active", svc], { encoding: "utf-8", timeout: 5000 }).trim();
      const isActive = output === "active";
      results.push({ service: svc, status: output, healthy: isActive });
      if (isActive) healthy++;
    } catch (e) {
      const status = String(e.stdout || "unknown").trim() || "unknown";
      results.push({ service: svc, status, healthy: false, error: e.message });
    }
  }
  const issues = results.filter(result => !result.healthy).map(result => `Service ${result.service} is ${result.status}`);
  return {
    results,
    score: services.length > 0 ? (healthy / services.length) * 100 : 0,
    healthy,
    total: services.length,
    issues
  };
}

function checkProcesses() {
  try {
    const output = execFileSync("ps", ["aux", "--sort=-%cpu"], {
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 5 * 1024 * 1024
    });
    const lines = output.trim().split("\n");
    const processes = lines.slice(1).map(line => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1]),
        cpu: parseFloat(parts[2]),
        mem: parseFloat(parts[3]),
        command: parts.slice(10).join(" ")
      };
    });
    const highCpu = processes.filter(p => p.cpu > 50);
    const highMem = processes.filter(p => p.mem > 50);
    const score = 100 - (highCpu.length * 10) - (highMem.length * 10);
    return {
      results: { top: processes.slice(0, 5), highCpu, highMem },
      score: Math.max(0, score),
      issues: [...highCpu.map(p => `High CPU: ${p.command} (${p.cpu}%)`), ...highMem.map(p => `High MEM: ${p.command} (${p.mem}%)`)]
    };
  } catch (e) {
    return {
      results: { top: [], highCpu: [], highMem: [] },
      score: 0,
      issues: [`Failed to check processes: ${e.message}`]
    };
  }
}

function checkDisk() {
  try {
    const output = execFileSync("df", ["-P"], { encoding: "utf-8", timeout: 5000 });
    const lines = output.trim().split("\n").slice(1);
    const disks = lines.map(line => {
      const parts = line.split(/\s+/);
      return {
        filesystem: parts[0],
        usage: parseInt(parts[4], 10),
        mount: parts.slice(5).join(" ")
      };
    }).filter(disk => Number.isFinite(disk.usage) && disk.mount);
    const critical = disks.filter(d => d.usage > 90);
    const warning = disks.filter(d => d.usage > 80 && d.usage <= 90);
    const score = 100 - (critical.length * 20) - (warning.length * 10);
    return {
      results: disks,
      score: Math.max(0, score),
      issues: [...critical.map(d => `Critical: ${d.mount} at ${d.usage}%`), ...warning.map(d => `Warning: ${d.mount} at ${d.usage}%`)]
    };
  } catch (e) {
    return { results: [], score: 0, issues: [`Failed to check disk: ${e.message}`] };
  }
}

function probeDns(hostname, timeoutMs = 4000) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, host: hostname, error: "Timed out" });
      }
    }, timeoutMs);

    dns.lookup(hostname, (error, address) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error
        ? { ok: false, host: hostname, error: error.message }
        : { ok: true, host: hostname, address });
    });
  });
}

function probeHttps(url, timeoutMs = 4000) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    let request;

    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ url, latencyMs: Date.now() - started, ...result });
    };

    try {
      request = https.request(url, { method: "HEAD" }, response => {
        response.resume();
        finish({ ok: true, statusCode: response.statusCode });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("Timed out")));
      request.on("error", error => finish({ ok: false, error: error.message }));
      request.end();
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
  });
}

async function checkNetwork(options = {}) {
  const issues = [];
  const recommendations = [];
  const targetUrl = options.targetUrl || process.env.SIDEKICK_HEALTHCHECK_URL || "https://github.com";
  let targetHost;
  try {
    targetHost = new URL(targetUrl).hostname;
  } catch {
    targetHost = "";
  }
  const dnsProbe = options.dnsProbe || probeDns;
  const httpsProbe = options.httpsProbe || probeHttps;
  const runFile = options.execFileSyncImpl || execFileSync;
  const services = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"];
  const servicePorts = {
    "sidekick-mcp": 4097,
    "sidekick-dashboard": 4098,
    "sidekick-agent": 4099
  };

  const [dnsResult, httpsResult] = await Promise.all([
    targetHost
      ? dnsProbe(targetHost)
      : Promise.resolve({ ok: false, host: targetHost, error: "Invalid health-check URL" }),
    httpsProbe(targetUrl)
  ]);
  if (!dnsResult.ok) issues.push(`DNS resolution failed for ${targetHost || targetUrl}: ${dnsResult.error}`);
  if (!httpsResult.ok) issues.push(`Outbound HTTPS failed for ${targetUrl}: ${httpsResult.error}`);

  let icmp = { target: "8.8.8.8", ok: false };
  try {
    runFile("ping", ["-c", "1", "-W", "2", "8.8.8.8"], {
      encoding: "utf-8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    icmp.ok = true;
  } catch (error) {
    icmp.error = error.message;
  }

  let listeners = "";
  try {
    listeners = runFile("ss", ["-tln"], { encoding: "utf-8", timeout: 5000 });
  } catch (e) {
    issues.push(`Failed to inspect listening ports: ${e.message}`);
  }

  const ports = {};
  for (const service of services) {
    const port = servicePorts[service];
    const listening = listeners.split("\n").some(line =>
      new RegExp(`[:.]${port}(?:\\s|$)`).test(line)
    );
    ports[service] = { port, listening };
    if (!listening) recommendations.push(`${service} not listening on port ${port}`);
  }
  const listeningCount = Object.values(ports).filter(port => port.listening).length;
  const score = (dnsResult.ok ? 25 : 0) +
    (httpsResult.ok ? 25 : 0) +
    (listeningCount / services.length) * 50;
  return {
    results: {
      internet: dnsResult.ok && httpsResult.ok,
      dns: dnsResult,
      https: httpsResult,
      icmp,
      ports
    },
    score,
    issues,
    recommendations
  };
}

function checkCustom(commands) {
  if (!commands) return { results: [], score: 100, issues: [] };
  const cmdList = commands.split(",").map(c => c.trim());
  const results = [];
  let allPassed = true;
  for (const cmd of cmdList) {
    try {
      const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
      results.push({ command: cmd, output, success: true });
    } catch (e) {
      results.push({ command: cmd, error: e.message, success: false });
      allPassed = false;
    }
  }
  return { results, score: allPassed ? 100 : 50, issues: results.filter(r => !r.success).map(r => `Failed: ${r.command}`) };
}

function parseThresholds(threshold) {
  if (!threshold) return {};
  const thresholds = {};
  const parts = threshold.split(",").map(t => t.trim());
  for (const part of parts) {
    const match = part.match(/^(\w+)([><=]+)(\d+)$/);
    if (match) {
      thresholds[match[1]] = { operator: match[2], value: parseInt(match[3]) };
    }
  }
  return thresholds;
}

function applyThresholds(results, thresholds) {
  const issues = [];
  for (const [metric, { operator, value }] of Object.entries(thresholds)) {
    if (metric === "disk" && results.disk?.results) {
      for (const disk of results.disk.results) {
        const usage = disk.usage;
        if ((operator === ">" && usage > value) || (operator === ">=" && usage >= value)) {
          issues.push(`Disk ${disk.mount} at ${usage}% exceeds threshold ${operator}${value}%`);
        }
      }
    }
    if (metric === "mem" && results.processes?.results?.top) {
      for (const proc of results.processes.results.top) {
        if ((operator === ">" && proc.mem > value) || (operator === ">=" && proc.mem >= value)) {
          issues.push(`Process ${proc.command} using ${proc.mem}% memory exceeds threshold ${operator}${value}%`);
        }
      }
    }
  }
  return issues;
}

function checkPlatformModules() {
  try {
    const repository = require("../../modules/repository");
    const loader = require("../../modules/loader");
    const modules = repository.listModules();
    const issues = [];
    const summary = [];
    for (const module of modules) {
      const active = loader.isModuleActive(module.name);
      summary.push({ name: module.name, state: module.state, active_in_process: active });
      if (module.state === "error") {
        const safeError = String(module.error || "unknown error").replace(/\s+/g, " ").slice(0, 200);
        issues.push(`Module ${module.name} is in error state: ${safeError}`);
      } else if ((module.state === "enabled" || module.state === "healthy") && !active) {
        issues.push(`Module ${module.name} is ${module.state} but not active in this process (tools unavailable here until reconciliation)`);
      }
    }
    // Disabled/uninstalled modules are operator intent, not health problems.
    const score = Math.max(0, 100 - issues.length * 40);
    return { score, modules: summary, issues: issues.length ? issues : undefined };
  } catch (e) {
    return { score: 0, issues: [`Module health check failed: ${e.message}`] };
  }
}

async function sidekick_health({ check, services, commands, threshold }) {
  const now = new Date().toISOString();
  const checks = check === "all" ? ["services", "processes", "disk", "network", "modules"] : [check];
  const results = {};
  let totalScore = 0;
  let totalChecks = 0;
  const allIssues = [];
  const allRecommendations = [];

  for (const c of checks) {
    if (c === "services") {
      results.services = checkServices(services);
      totalScore += results.services.score;
      totalChecks++;
      if (results.services.issues) allIssues.push(...results.services.issues);
    } else if (c === "processes") {
      results.processes = checkProcesses();
      totalScore += results.processes.score;
      totalChecks++;
      if (results.processes.issues) allIssues.push(...results.processes.issues);
    } else if (c === "disk") {
      results.disk = checkDisk();
      totalScore += results.disk.score;
      totalChecks++;
      if (results.disk.issues) allIssues.push(...results.disk.issues);
    } else if (c === "network") {
      results.network = await checkNetwork();
      totalScore += results.network.score;
      totalChecks++;
      if (results.network.issues) allIssues.push(...results.network.issues);
      if (results.network.recommendations) allRecommendations.push(...results.network.recommendations);
    } else if (c === "custom") {
      results.custom = checkCustom(commands);
      totalScore += results.custom.score;
      totalChecks++;
      if (results.custom.issues) allIssues.push(...results.custom.issues);
    } else if (c === "modules") {
      results.modules = checkPlatformModules();
      totalScore += results.modules.score;
      totalChecks++;
      if (results.modules.issues) allIssues.push(...results.modules.issues);
    } else {
      return { content: [{ type: "text", text: `Unknown check: ${c}. Use: all, services, processes, disk, network, custom, modules` }], isError: true };
    }
  }

  const thresholds = parseThresholds(threshold);
  const thresholdIssues = applyThresholds(results, thresholds);
  allIssues.push(...thresholdIssues);

  const overallScore = totalChecks > 0 ? Math.round(totalScore / totalChecks) : 0;

  const history = loadHealthHistory();
  history.push({ date: now, score: overallScore, checks: checks.join(","), issues: allIssues.length });
  if (history.length > MAX_HEALTH_HISTORY) history.splice(0, history.length - MAX_HEALTH_HISTORY);
  saveHealthHistory(history);

  let output = `# Health Check Report\n\n`;
  output += `**Overall Score: ${overallScore}/100**\n`;
  output += `**Time: ${now}**\n\n`;

  for (const c of checks) {
    output += `## ${c.charAt(0).toUpperCase() + c.slice(1)}\n`;
    if (c === "services") {
      output += `- Score: ${results.services.score.toFixed(0)}/100\n`;
      output += `- Services: ${results.services.healthy}/${results.services.total} healthy\n`;
      for (const svc of results.services.results) {
        output += `  - ${svc.service}: ${svc.status} ${svc.healthy ? "✓" : "✗"}\n`;
      }
    } else if (c === "processes") {
      output += `- Score: ${results.processes.score.toFixed(0)}/100\n`;
      output += `- Top processes (by CPU):\n`;
      for (const proc of results.processes.results?.top || []) {
        output += `  - ${proc.command.substring(0, 40)}: CPU ${proc.cpu}%, MEM ${proc.mem}%\n`;
      }
    } else if (c === "disk") {
      output += `- Score: ${results.disk.score.toFixed(0)}/100\n`;
      output += `- Disk usage:\n`;
      for (const disk of Array.isArray(results.disk.results) ? results.disk.results : []) {
        output += `  - ${disk.mount}: ${disk.usage}%\n`;
      }
    } else if (c === "network") {
      output += `- Score: ${results.network.score.toFixed(0)}/100\n`;
      output += `- Internet: ${results.network.results?.internet ? "✓" : "✗"}\n`;
      const dnsResult = results.network.results?.dns;
      const httpsResult = results.network.results?.https;
      const icmpResult = results.network.results?.icmp;
      output += `- DNS (${dnsResult?.host || "unknown"}): ${dnsResult?.ok ? "✓" : "✗"}\n`;
      output += `- HTTPS (${httpsResult?.url || "unknown"}): ${httpsResult?.ok ? `✓ ${httpsResult.statusCode || ""} (${httpsResult.latencyMs}ms)`.trim() : "✗"}\n`;
      output += `- ICMP (${icmpResult?.target || "unknown"}): ${icmpResult?.ok ? "✓" : "✗"} (informational)\n`;
      output += `- Ports:\n`;
      for (const [svc, info] of Object.entries(results.network.results?.ports || {})) {
        output += `  - ${svc} (${info.port}): ${info.listening ? "listening" : "not listening"}\n`;
      }
    } else if (c === "modules") {
      output += `- Score: ${results.modules.score.toFixed(0)}/100\n`;
      const moduleRows = results.modules.modules || [];
      if (moduleRows.length === 0 && !(results.modules.issues || []).length) output += `- No platform modules registered\n`;
      for (const module of moduleRows) {
        output += `  - ${module.name}: ${module.state}${module.active_in_process ? " (active)" : " (inactive in this process)"}\n`;
      }
    } else if (c === "custom") {
      output += `- Score: ${results.custom.score.toFixed(0)}/100\n`;
      for (const res of Array.isArray(results.custom.results) ? results.custom.results : []) {
        output += `  - ${res.command}: ${res.success ? "✓" : "✗"}\n`;
        if (res.output) output += `    ${res.output.substring(0, 100)}\n`;
      }
    }
    output += `\n`;
  }

  if (allIssues.length > 0) {
    output += `## Issues (${allIssues.length})\n`;
    for (const issue of allIssues) {
      output += `- ${issue}\n`;
    }
    output += `\n`;
  }

  if (allRecommendations.length > 0) {
    output += `## Recommendations\n`;
    for (const rec of allRecommendations) {
      output += `- ${rec}\n`;
    }
    output += `\n`;
  }

  if (overallScore >= 90) {
    output += `**Status: HEALTHY** ✓\n`;
  } else if (overallScore >= 70) {
    output += `**Status: WARNING** ⚠\n`;
  } else {
    output += `**Status: CRITICAL** ✗\n`;
  }

  return { content: [{ type: "text", text: output }] };
}

async function sidekick_status({ include, services }) {
  const sections = (include || "services,disk").split(",").map(s => s.trim());
  const output = {};
  if (sections.includes("services")) {
    const svcList = (services || "sidekick-mcp,sidekick-dashboard,sidekick-agent").split(",").map(s => s.trim());
    output.services = {};
    for (const svc of svcList) {
      try {
        const stdout = execFileSync("systemctl", ["is-active", svc], { timeout: 5000, encoding: "utf-8" }).trim();
        output.services[svc] = stdout;
      } catch (e) {
        output.services[svc] = (e.stdout || "unknown").trim();
      }
    }
  }
  if (sections.includes("disk")) {
    try {
      const stdout = execFileSync("df", ["-h", "--output=target,size,used,avail,pcent", "/"], {
        timeout: 5000, encoding: "utf-8"
      }).trim();
      const lines = stdout.split("\n");
      if (lines.length > 1) {
        const parts = lines[1].trim().split(/\s+/);
        output.disk = { mount: parts[0], size: parts[1], used: parts[2], avail: parts[3], pct: parts[4] };
      }
    } catch (e) { output.disk = { error: e.message }; }
  }
  if (sections.includes("memory")) {
    try {
      const stdout = execFileSync("free", ["-h"], { timeout: 5000, encoding: "utf-8" }).trim();
      const lines = stdout.split("\n");
      if (lines.length > 1) {
        const parts = lines[1].trim().split(/\s+/);
        output.memory = { total: parts[1], used: parts[2], free: parts[3] };
      }
    } catch (e) { output.memory = { error: e.message }; }
  }
  if (sections.includes("load")) {
    try {
      const stdout = fs.readFileSync("/proc/loadavg", "utf-8").trim();
      const parts = stdout.split(/\s+/);
      output.load = { "1m": parts[0], "5m": parts[1], "15m": parts[2] };
    } catch (e) { output.load = { error: e.message }; }
  }
  if (sections.includes("uptime")) {
    try {
      const stdout = execFileSync("uptime", ["-p"], { timeout: 5000, encoding: "utf-8" }).trim();
      output.uptime = stdout;
    } catch (e) { output.uptime = { error: e.message }; }
  }
  if (sections.includes("modules")) {
    try {
      const repository = require("../../modules/repository");
      const loader = require("../../modules/loader");
      output.modules = repository.listModules().map(m => ({
        name: m.name,
        state: m.state,
        version: m.version,
        type: m.type,
        active_in_process: loader.isModuleActive(m.name),
        tools: Object.keys(m.manifest.tools || {}),
        error: m.error ? String(m.error).replace(/\s+/g, " ").slice(0, 200) : undefined,
        error_count: m.error_count || undefined,
      }));
    } catch (e) { output.modules = { error: e.message }; }
  }
  if (sections.includes("processes")) {
    try {
      const stdout = execFileSync("ps", ["aux", "--sort=-%cpu"], { timeout: 5000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
      const lines = stdout.trim().split("\n").slice(0, 11);
      output.processes_top = lines.slice(1).map(l => {
        const p = l.trim().split(/\s+/);
        return { user: p[0], pid: p[1], cpu: p[2], mem: p[3], cmd: p.slice(10).join(" ").substring(0, 80) };
      });
    } catch (e) { output.processes_top = []; }
  }
  output.timestamp = new Date().toISOString();
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

const MAX_NETDIAG_COMMANDS = 15;
const COMMON_PORTS = [22, 80, 443, 3000, 3001, 4000, 5000, 8080, 8443, 9090];

function runNetDiagCommand(cmd, timeout = 5000) {
  try {
    const output = execSync(cmd, { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] });
    return { success: true, output: output.trim() };
  } catch (e) {
    return { success: false, output: (e.stdout || "") + (e.stderr || ""), error: e.message };
  }
}

async function sidekick_netdiag({ action, target, port_range, timeout, format }) {
  if (!target && action !== "listeners") {
    return { content: [{ type: "text", text: "target required (host, URL, or IP)" }], isError: true };
  }

  const fmt = format || "detailed";
  const to = timeout || 5000;
  let commandCount = 0;

  const checkLimit = () => {
    commandCount++;
    if (commandCount > MAX_NETDIAG_COMMANDS) {
      throw new Error(`Exceeded max commands per diagnostic (${MAX_NETDIAG_COMMANDS})`);
    }
  };

  if (action === "dns") {
    checkLimit();
    const dnsResult = runNetDiagCommand(`dig +short ${shellEscape(target)} A`, to);
    checkLimit();
    const dnsAny = runNetDiagCommand(`dig +short ${shellEscape(target)} ANY`, to);
    checkLimit();
    const reverse = runNetDiagCommand(`dig +short -x ${shellEscape(target)}`, to);

    let result = `DNS Resolution for: ${target}\n\n`;
    result += `A Records:\n${dnsResult.output || "None"}\n\n`;
    result += `ANY Records:\n${dnsAny.output || "None"}\n\n`;
    result += `Reverse DNS:\n${reverse.output || "None"}`;

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "route") {
    checkLimit();
    const traceResult = runNetDiagCommand(`traceroute -m 10 -w 2 ${shellEscape(target)}`, to * 2);

    let result = `Route to: ${target}\n\n`;
    result += traceResult.output || "Traceroute failed or timed out";

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "ports") {
    let ports = COMMON_PORTS;
    if (port_range) {
      const match = port_range.match(/(\d+)-(\d+)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = parseInt(match[2]);
        ports = [];
        for (let i = start; i <= end && ports.length < 20; i++) {
          ports.push(i);
        }
      }
    }

    checkLimit();
    const results = [];
    for (const port of ports) {
      const ncResult = runNetDiagCommand(`nc -z -w 2 ${shellEscape(target)} ${port} 2>&1`, 3000);
      const isOpen = ncResult.success && !ncResult.output.includes("failed");
      results.push({ port, open: isOpen });
    }

    let result = `Port Scan for: ${target}\n\n`;
    const openPorts = results.filter(r => r.open);
    const closedPorts = results.filter(r => !r.open);

    result += `Open: ${openPorts.length}\n`;
    if (openPorts.length > 0) {
      result += `  ${openPorts.map(r => r.port).join(", ")}\n`;
    }
    result += `\nClosed: ${closedPorts.length}\n`;
    if (fmt === "detailed" && closedPorts.length > 0) {
      result += `  ${closedPorts.map(r => r.port).join(", ")}\n`;
    }

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "listeners") {
    checkLimit();
    const ssResult = runNetDiagCommand("ss -tlnp", to);

    let result = "Local Listening Ports\n\n";
    result += ssResult.output || "No listeners found or ss command failed";

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "connectivity") {
    const targets = target.split(",").map(t => t.trim());
    const results = [];

    for (const t of targets) {
      checkLimit();
      const pingResult = runNetDiagCommand(`ping -c 2 -W 2 ${shellEscape(t)} 2>&1`, to);
      const isUp = pingResult.success && pingResult.output.includes("bytes from");
      results.push({ target: t, up: isUp, latency: isUp ? pingResult.output.match(/time[=<](\d+\.?\d*)/)?.[1] + "ms" : "N/A" });
    }

    let result = "Connectivity Check\n\n";
    for (const r of results) {
      result += `${r.target}: ${r.up ? "✓ UP" : "✗ DOWN"} (${r.latency})\n`;
    }

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "check") {
    let host = target;
    let url = null;
    if (target.startsWith("http://") || target.startsWith("https://")) {
      try {
        const parsed = new URL(target);
        host = parsed.hostname;
        url = target;
      } catch {}
    }

    const report = { target, host, timestamp: new Date().toISOString(), checks: {} };

    checkLimit();
    const dnsResult = runNetDiagCommand(`dig +short ${shellEscape(host)} A`, to);
    report.checks.dns = dnsResult.output || "Failed";

    checkLimit();
    const pingResult = runNetDiagCommand(`ping -c 2 -W 2 ${shellEscape(host)} 2>&1`, to);
    report.checks.ping = pingResult.success && pingResult.output.includes("bytes from") ? "OK" : "Failed";

    if (url) {
      checkLimit();
      const curlResult = runNetDiagCommand(`curl -s -o /dev/null -w "%{http_code}|%{time_total}|%{ssl_verify_result}" --max-time ${to / 1000} ${shellEscape(url)}`, to);
      if (curlResult.success) {
        const parts = curlResult.output.split("|");
        report.checks.http = {
          status: parts[0] || "N/A",
          time: parts[1] ? parseFloat(parts[1]).toFixed(3) + "s" : "N/A",
          ssl: parts[2] === "0" ? "Valid" : "Invalid"
        };
      } else {
        report.checks.http = "Failed";
      }
    }

    checkLimit();
    const portResult = runNetDiagCommand(`nc -z -w 2 ${shellEscape(host)} 22 2>&1`, 3000);
    report.checks.ssh = portResult.success && !portResult.output.includes("failed") ? "Open" : "Closed";

    let result = `Network Diagnostic Report\n`;
    result += `Target: ${target}\n`;
    result += `Time: ${report.timestamp}\n\n`;
    result += `DNS: ${report.checks.dns}\n`;
    result += `Ping: ${report.checks.ping}\n`;
    if (report.checks.http) {
      if (typeof report.checks.http === "object") {
        result += `HTTP: ${report.checks.http.status} (${report.checks.http.time}, SSL: ${report.checks.http.ssl})\n`;
      } else {
        result += `HTTP: ${report.checks.http}\n`;
      }
    }
    result += `SSH (22): ${report.checks.ssh}\n`;

    return { content: [{ type: "text", text: result }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: check, dns, route, ports, listeners, connectivity" }], isError: true };
}

const METRICS_METADATA_TTL_MS = 30_000;
const metricsMetadataCache = new Map();

function cachedMetricsMetadata(key) {
  const entry = metricsMetadataCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    metricsMetadataCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheMetricsMetadata(key, value) {
  metricsMetadataCache.set(key, { value, expiresAt: Date.now() + METRICS_METADATA_TTL_MS });
  return value;
}

async function sidekick_metrics({ action, measurement, fields, tags, timestamp, query, time_range }) {
  try {
    const INFLUX_URL = process.env.SIDEKICK_INFLUX_URL || 'http://localhost:8086';
    const INFLUX_TOKEN = process.env.SIDEKICK_INFLUX_TOKEN || '';
    const INFLUX_ORG = process.env.SIDEKICK_INFLUX_ORG || 'sidekick';
    const INFLUX_BUCKET = process.env.SIDEKICK_INFLUX_BUCKET || 'sidekick';

    if (!INFLUX_TOKEN || INFLUX_TOKEN === 'sidekick-influx-token') {
      return { content: [{ type: "text", text: "Error: SIDEKICK_INFLUX_TOKEN must be set to a non-placeholder value" }], isError: true };
    }

    if (action === "write") {
      if (!measurement || !fields || typeof fields !== 'object') {
        return { content: [{ type: "text", text: "Error: measurement and fields object are required for write" }], isError: true };
      }

      // Build line protocol
      let line = measurement;

      // Add tags
      if (tags && typeof tags === 'object') {
        const tagPairs = Object.entries(tags).map(([k, v]) => `${k}=${v}`);
        if (tagPairs.length > 0) {
          line += ',' + tagPairs.join(',');
        }
      }

      // Add fields
      const fieldPairs = Object.entries(fields).map(([k, v]) => {
        if (typeof v === 'number') {
          return `${k}=${v}`;
        } else if (typeof v === 'boolean') {
          return `${k}=${v}`;
        } else {
          return `${k}="${String(v).replace(/"/g, '\\"')}"`;
        }
      });
      line += ' ' + fieldPairs.join(',');

      // Add timestamp
      const ts = timestamp || Date.now() * 1000000; // nanoseconds
      line += ' ' + ts;

      // Write to InfluxDB
      const response = await fetch(`${INFLUX_URL}/api/v2/write?org=${INFLUX_ORG}&bucket=${INFLUX_BUCKET}&precision=ns`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${INFLUX_TOKEN}`,
          'Content-Type': 'text/plain; charset=utf-8'
        },
        body: line
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: "text", text: `Error writing to InfluxDB: ${response.status} - ${errorText}` }], isError: true };
      }

      return { content: [{ type: "text", text: `Successfully wrote metric: ${measurement}` }] };
    }

    if (action === "query") {
      if (!query) {
        return { content: [{ type: "text", text: "Error: query is required for query action" }], isError: true };
      }

      const response = await fetch(`${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${INFLUX_TOKEN}`,
          'Content-Type': 'application/vnd.flux',
          'Accept': 'application/json'
        },
        body: query
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: "text", text: `Error querying InfluxDB: ${response.status} - ${errorText}` }], isError: true };
      }

      const result = await response.text();
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "list_measurements") {
      const cacheKey = `measurements:${INFLUX_BUCKET}`;
      const cached = cachedMetricsMetadata(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached) }] };

      const fluxQuery = `from(bucket: "${INFLUX_BUCKET}")
  |> range(start: -30d)
  |> group()
  |> distinct(column: "_measurement")
  |> keep(columns: ["_measurement"])`;

      const response = await fetch(`${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${INFLUX_TOKEN}`,
          'Content-Type': 'application/vnd.flux',
          'Accept': 'application/json'
        },
        body: fluxQuery
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: "text", text: `Error listing measurements: ${response.status} - ${errorText}` }], isError: true };
      }

      const result = await response.text();
      const values = cacheMetricsMetadata(cacheKey, parseInfluxCsvColumn(result, "_measurement"));
      return { content: [{ type: "text", text: JSON.stringify(values) }] };
    }

    if (action === "list_fields") {
      if (!measurement) {
        return { content: [{ type: "text", text: "Error: measurement is required for list_fields" }], isError: true };
      }

      const range = time_range || '-30d';
      const cacheKey = `fields:${INFLUX_BUCKET}:${measurement}:${range}`;
      const cached = cachedMetricsMetadata(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached) }] };

      const safeMeasurement = String(measurement).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const fluxQuery = `from(bucket: "${INFLUX_BUCKET}")
  |> range(start: ${range})
  |> filter(fn: (r) => r._measurement == "${safeMeasurement}")
  |> group()
  |> distinct(column: "_field")
  |> keep(columns: ["_field"])`;

      const response = await fetch(`${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${INFLUX_TOKEN}`,
          'Content-Type': 'application/vnd.flux',
          'Accept': 'application/json'
        },
        body: fluxQuery
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: "text", text: `Error listing fields: ${response.status} - ${errorText}` }], isError: true };
      }

      const result = await response.text();
      const values = cacheMetricsMetadata(cacheKey, parseInfluxCsvColumn(result, "_field"));
      return { content: [{ type: "text", text: JSON.stringify(values) }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: write, query, list_measurements, list_fields" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// InfluxDB's annotated CSV includes result/table metadata before the actual
// column header. Normalize it at the tool boundary so callers receive useful
// values rather than transport headers.
function parseInfluxCsvColumn(csv, column) {
  const lines = String(csv || "").split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  if (!lines.length) return [];
  const header = lines[0].split(",");
  const index = header.indexOf(column);
  if (index < 0) return [];
  return [...new Set(lines.slice(1)
    .map(line => line.split(",")[index])
    .filter(value => value !== undefined && value !== ""))].sort();
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "status",
    description: "Unified system status: services, disk, memory, load, uptime, top processes, platform modules in one call.",
    schema: z.object({
      include: z.string().optional().describe("Sections: services,disk,memory,load,uptime,processes,modules (default: services,disk)"),
      services: z.string().optional().describe("Comma-separated service names (default: sidekick-mcp,sidekick-dashboard,sidekick-agent)"),
    }),
    args: { include: "string (optional, comma-separated: services,disk,memory,load,uptime,processes,modules - default services,disk)", services: "string (optional, comma-separated service names - default sidekick-mcp,sidekick-dashboard,sidekick-agent)" },
    risk: "medium",
    category: "Monitoring",
    source: "builtin",
    family: "observability",
    handler: sidekick_status,
  }),
  Object.freeze({
    name: "health",
    description: "Composite system health checks with scoring and issue detection",
    schema: z.object({
      check: z.enum(["all", "services", "processes", "disk", "network", "custom", "modules"]).describe("Health check type: all (services+processes+disk+network+modules), services, processes, disk, network, custom commands, or platform modules"),
      services: z.string().optional().describe("Comma-separated service names for services check (default: sidekick-mcp,sidekick-dashboard,sidekick-agent)"),
      commands: z.string().optional().describe("Comma-separated shell commands for custom check"),
      threshold: z.string().optional().describe("Alert thresholds (e.g. 'disk>90,mem>80')"),
    }),
    args: { check: "string (all|services|processes|disk|network|custom|modules)", services: "string (optional, comma-separated service names)", commands: "string (optional, comma-separated commands for custom check)", threshold: "string (optional, e.g. 'disk>90,mem>80')" },
    risk: "high",
    category: "Monitoring",
    source: "builtin",
    family: "observability",
    handler: sidekick_health,
  }),
  Object.freeze({
    name: "metrics",
    description: "Metrics collection and querying with InfluxDB: write metrics, query data, list measurements and fields",
    schema: z.object({
      action: z.enum(["write", "query", "list_measurements", "list_fields"]).describe("Metrics action"),
      measurement: z.string().optional().describe("Measurement name (for write/list_fields)"),
      fields: z.record(z.any()).optional().describe("Field values (for write)"),
      tags: z.record(z.string()).optional().describe("Tags (for write)"),
      timestamp: z.number().optional().describe("Nanosecond timestamp (for write)"),
      query: z.string().optional().describe("Flux query (for query action)"),
      time_range: z.string().optional().describe("Time range for list_fields (e.g. -30d)"),
    }),
    args: { action: "string (write|query|list_measurements|list_fields)", measurement: "string (measurement name for write/list_fields)", fields: "object (field values for write)", tags: "object (optional, tags for write)", timestamp: "number (optional, nanosecond timestamp for write)", query: "string (Flux query for query action)", time_range: "string (optional, time range for list_fields, e.g. -30d)" },
    risk: "low",
    category: "Monitoring",
    source: "builtin",
    family: "observability",
    handler: sidekick_metrics,
  }),
  Object.freeze({
    name: "netdiag",
    description: "Unified network diagnostics: DNS, routing, port scanning, connectivity checks, and local listeners.",
    schema: z.object({
      action: z.enum(["check", "dns", "route", "ports", "listeners", "connectivity"]),
      target: z.string().describe("Host, URL, or IP to diagnose"),
      port_range: z.string().optional().describe("Port range for scan (e.g., '80-443')"),
      timeout: z.number().optional().default(5000),
      format: z.enum(["detailed", "compact", "json"]).optional().default("detailed"),
    }),
    args: { action: "string (check|dns|route|ports|listeners|connectivity)", target: "string (host, URL, or IP to diagnose)", port_range: "string (optional, port range e.g. '80-443')", timeout: "number (optional, timeout in ms - default 5000)", format: "string (optional, detailed|compact|json - default detailed)" },
    risk: "high",
    category: "Monitoring",
    source: "builtin",
    family: "observability",
    handler: sidekick_netdiag,
  }),
]);

module.exports = { descriptors, sidekick_status, sidekick_health, sidekick_metrics, sidekick_netdiag, checkNetwork };
