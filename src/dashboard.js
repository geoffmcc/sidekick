require("./env");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { timingSafeCompare } = require("./crypto-utils");
const { execSync } = require("child_process");
const { getToolDefsForSource, getToolCategoriesWithTools, buildPolicyInspection, summarizePolicyInspection, enforceToolPolicy, listApprovals, resolveApproval } = require("./tools");
const dbStore = require("./db");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const PORT = parseInt(process.env.SIDEKICK_DASHBOARD_PORT || "4098", 10);
const MCP_PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const MCP_API_KEY = process.env.SIDEKICK_API_KEY;
if (!MCP_API_KEY || MCP_API_KEY === "sk-sidekick-local-dev" || MCP_API_KEY === "sk-your-key-here") {
  throw new Error("SIDEKICK_API_KEY must be set to a non-placeholder value");
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use("/static", express.static(path.join(__dirname, "..", "static")));
const http = require("http");
const AGENT_PORT = parseInt(process.env.SIDEKICK_AGENT_PORT || "4099", 10);

function getPublicIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'unknown';
}
const VPS_IP = getPublicIP();

const DASHBOARD_USER = process.env.SIDEKICK_DASHBOARD_USER || "";
const DASHBOARD_PASS = process.env.SIDEKICK_DASHBOARD_PASS || "";
const DASHBOARD_ALLOWED_IPS = (process.env.SIDEKICK_DASHBOARD_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);

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

// Rate limiting (in-memory, per IP)
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 200;

function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = (rateLimit.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) return false;
  timestamps.push(now);
  rateLimit.set(ip, timestamps);
  return true;
}

function isSameOrigin(origin, host) {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Audit logging
const AUDIT_LOG = path.join(DATA_DIR, 'audit.jsonl');
function auditLog(req, action, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    key: req.params.key || null,
    ip: req.ip,
    user: (() => {
      const auth = req.headers.authorization;
      if (auth && auth.startsWith('Basic ')) {
        return Buffer.from(auth.slice(6), 'base64').toString().split(':')[0];
      }
      return 'anonymous';
    })(),
    details
  };
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(AUDIT_LOG, line);
}

// Error logging
const ERROR_LOG = path.join(DATA_DIR, 'dashboard-errors.log');
function logError(url, status, error, page, userAgent) {
  const entry = {
    timestamp: new Date().toISOString(),
    url,
    status,
    error: error.message || String(error),
    page,
    userAgent,
    logged: new Date().toISOString()
  };
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(ERROR_LOG, line);
}

function getJsonFromLocalService(port, pathName, headers = {}, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method: "GET",
      headers,
      timeout
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(body || "{}"));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

// IP whitelist middleware
if (DASHBOARD_ALLOWED_IPS.length) {
  app.use((req, res, next) => {
    const ip = req.ip === '::ffff:127.0.0.1' ? '127.0.0.1' : req.ip;
    if (ip === '127.0.0.1' || ip === '::1' || DASHBOARD_ALLOWED_IPS.some(entry => ipInRange(ip, entry))) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  });
}

// Rate limiting middleware
app.use((req, res, next) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests, please try again later' });
  }
  next();
});

// Request size limit
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 1024 * 1024) {
    return res.status(413).json({ error: 'Request too large' });
  }
  next();
});

// CSRF protection - validate Origin header for state-changing requests
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && !isSameOrigin(origin, host)) {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }
  next();
});

if (DASHBOARD_USER && DASHBOARD_PASS) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/static/')) return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Basic ")) {
      res.set("WWW-Authenticate", 'Basic realm="Sidekick Dashboard"');
      return res.status(401).send("Authentication required");
    }
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const separator = decoded.indexOf(":");
    const user = separator >= 0 ? decoded.slice(0, separator) : "";
    const pass = separator >= 0 ? decoded.slice(separator + 1) : "";
    if (timingSafeCompare(user, DASHBOARD_USER) && timingSafeCompare(pass, DASHBOARD_PASS)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Sidekick Dashboard"');
    res.status(401).send("Authentication required");
  });
}

// --- API ---

function readLogs() {
  return dbStore.readToolLogs();
}

function readKV() {
  return dbStore.loadKV({});
}

function writeKV(data) {
  dbStore.replaceKV(data || {});
}

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000, ...opts }).trim();
  } catch { return "?"; }
}

function seedKV() {
  const kv = readKV();
  const repoRoot = path.join(__dirname, "..");
  const now = new Date().toISOString();

  // Read version.json instead of running git commands
  let versionInfo = { commit: "?", branch: "?", remote_url: "?" };
  try {
    const versionPath = path.join(__dirname, "..", "version.json");
    if (fs.existsSync(versionPath)) {
      versionInfo = JSON.parse(fs.readFileSync(versionPath, "utf-8"));
    }
  } catch {}

  const seed = {
    "server:hostname": exec("hostname"),
    "server:os": exec('lsb_release -d -s 2>/dev/null || . /etc/os-release && echo "$PRETTY_NAME"'),
    "server:kernel": exec("uname -r"),
    "server:arch": exec("uname -m"),
    "server:cpu": exec(`grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2 | xargs`),
    "server:memory_total": exec(`grep MemTotal /proc/meminfo | awk '{print $2 " " $3}'`),
    "server:swap_total": exec(`grep SwapTotal /proc/meminfo | awk '{print $2 " " $3}'`),
    "server:disk_total_root": exec("df -h / | tail -1 | awk '{print $2}'"),
    "server:processes": exec("ps aux | wc -l"),
    "server:uptime_at_start": exec("uptime -p"),

    "network:public_ip": exec("curl -s ifconfig.me 2>/dev/null || echo ?"),
    "network:private_ip": exec("hostname -I | awk '{print $1}'"),
    "network:interfaces": exec("ip -o link show | awk -F': ' '{print $2}' | paste -sd,"),
    "network:dns": exec(`grep nameserver /etc/resolv.conf | awk '{print $2}' | paste -sd,`),
    "network:gateway": exec("ip route | grep default | awk '{print $3}'"),

    "services:sidekick-mcp": exec("systemctl is-active sidekick-mcp"),
    "services:sidekick-dashboard": exec("systemctl is-active sidekick-dashboard"),
    "services:sidekick-agent": exec("systemctl is-active sidekick-agent"),
    "services:ollama": exec("systemctl is-active ollama"),

    "security:ufw": exec("systemctl is-active ufw"),
    "security:fail2ban": exec("systemctl is-active fail2ban"),
    "security:ssh_port": (() => { try { const c = fs.readFileSync("/etc/ssh/sshd_config","utf-8").match(/^Port\s+(\d+)/m); return c ? c[1] : "22"; } catch { return "22"; } })(),
    "security:last_login": "[redacted on startup]",
    "security:failed_logins": "[redacted on startup]",

    "software:node_version": exec("node --version"),
    "software:npm_version": exec("npm --version"),
    "software:ollama_version": exec("ollama --version 2>/dev/null || echo not found"),
    "software:python_version": exec("python3 --version 2>/dev/null || echo not found"),

    "deploy:git_commit": versionInfo.commit || "?",
    "deploy:branch": versionInfo.branch || "?",
    "deploy:remote_url": versionInfo.remote_url || "?",
    "deploy:initialized": now,

    "config:timezone": exec("timedatectl show -p Timezone --value 2>/dev/null || echo UTC"),
    "config:locale": exec(`grep LANG= /etc/default/locale 2>/dev/null | cut -d= -f2 || echo C.UTF-8`),
    "config:env": process.env.NODE_ENV || "production",
  };

  for (const [key, value] of Object.entries(seed)) {
    if (!(key in kv)) {
      kv[key] = {
        value: value,
        project: "system",
        source: "dashboard",
        created: now,
        updated: now
      };
    }
  }

  const stale = Object.keys(kv).filter(k => k.startsWith("security:failed_logins_24h"));
  stale.forEach(k => delete kv[k]);
  writeKV(kv);
  console.log("Seed KV written with", Object.keys(seed).length, "keys");
}

app.get("/api/logs", (req, res) => {
  const logs = readLogs();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({ entries: logs.slice(0, limit), total: logs.length });
});

app.get("/api/kv", (req, res) => {
  const kv = readKV();
  const entries = Object.entries(kv).map(([key, entry]) => {
    if (typeof entry === 'object' && entry !== null && 'value' in entry) {
      return { key, value: entry.value, project: entry.project, source: entry.source, created: entry.created, updated: entry.updated };
    } else {
      return { key, value: entry, project: null, source: null, created: null, updated: null };
    }
  });
  res.json({ entries, total: entries.length });
});

app.get("/api/system", (req, res) => {
  try {
    const uptime = execSync("uptime -p", { encoding: "utf-8", timeout: 5000 }).trim();
    const mem = execSync("free -h | grep Mem", { encoding: "utf-8", timeout: 5000 }).trim().split(/\s+/);
    const disk = execSync("df -h / | tail -1", { encoding: "utf-8", timeout: 5000 }).trim().split(/\s+/);
    const cpu = execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", { encoding: "utf-8", timeout: 5000 }).trim();
    const load = execSync("cat /proc/loadavg | awk '{print $1,$2,$3}'", { encoding: "utf-8", timeout: 5000 }).trim();
    const diskFree = disk.length >= 4 ? disk[3] : "?";
    const diskTotal = disk.length >= 2 ? disk[1] : "?";
    const diskPct = disk.length >= 5 ? disk[4] : "?";
    res.json({
      uptime,
      memory: { total: mem[1] || "?", used: mem[2] || "?", free: mem[3] || "?", pct: mem[4] || "?" },
      disk: { total: diskTotal, free: diskFree, pct: diskPct },
      cpu: cpu || "0%",
      load
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/api/dashboard-summary", async (req, res) => {
  try {
    // Health score calculation
    const mem = execSync("free -h | grep Mem", { encoding: "utf-8", timeout: 5000 }).trim().split(/\s+/);
    const disk = execSync("df -h / | tail -1", { encoding: "utf-8", timeout: 5000 }).trim().split(/\s+/);
    const cpu = execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", { encoding: "utf-8", timeout: 5000 }).trim();
    
    const cpuPct = parseFloat(cpu) || 0;
    const memPct = mem.length >= 5 ? parseFloat(mem[4]) || 0 : 0;
    const diskPct = disk.length >= 5 ? parseFloat(disk[4]) || 0 : 0;
    
    // Calculate health score (100 = perfect, deduct for high usage)
    let healthScore = 100;
    if (cpuPct > 80) healthScore -= 30;
    else if (cpuPct > 50) healthScore -= 15;
    if (memPct > 90) healthScore -= 30;
    else if (memPct > 70) healthScore -= 15;
    if (diskPct > 90) healthScore -= 30;
    else if (diskPct > 70) healthScore -= 15;
    healthScore = Math.max(0, healthScore);
    
    // Storage info
    let kvCount = 0;
    try {
      kvCount = Object.keys(dbStore.loadKV({})).length;
    } catch {}
    
    let logSize = 0;
    try {
      logSize = fs.existsSync(dbStore.DB_FILE) ? fs.statSync(dbStore.DB_FILE).size : 0;
    } catch {}
    
    let convCount = 0;
    try {
      const convDir = path.join(DATA_DIR, "conversations");
      if (fs.existsSync(convDir)) {
        convCount = fs.readdirSync(convDir).filter(f => f.endsWith(".json")).length;
      }
    } catch {}
    
    // Active sessions
    let mcpClients = 0;
    let mcpSessionDetails = [];
    try {
      const mcpHealth = await getJsonFromLocalService(MCP_PORT, "/health", {
        "Authorization": "Bearer " + MCP_API_KEY
      });
      mcpClients = Number(mcpHealth.sessions) || 0;
      mcpSessionDetails = Array.isArray(mcpHealth.sessionDetails) ? mcpHealth.sessionDetails : [];
    } catch (e) {}
    
    let cronJobs = 0;
    try {
      const cronData = dbStore.loadDocument("cron", []);
      cronJobs = cronData.length || 0;
    } catch {}
    
    let activeWatches = 0;
    try {
      const watchData = dbStore.loadDocument("watches", []);
      activeWatches = watchData.filter(w => w.status === "active").length;
    } catch {}
    
    let agentStatus = "idle";
    try {
      const agentStatusRes = execSync("curl -s http://127.0.0.1:4099/api/agent/status 2>/dev/null || echo '{}'", { encoding: "utf-8", timeout: 3000 }).trim();
      const agentData = JSON.parse(agentStatusRes);
      if (agentData.activeTasks > 0) {
        agentStatus = `running (${agentData.activeTasks})`;
      }
    } catch {
      agentStatus = "offline";
    }
    
    // Recent errors (last 3 failures from log)
    let recentErrors = [];
    try {
      const errors = dbStore.readToolLogs(100).filter(e => !e.ok);
      recentErrors = errors.slice(0, 3).map(e => ({
        tool: e.n,
        time: e.t,
        summary: (e.s || "").substring(0, 80)
      }));
    } catch {}
    
    // Recent deployments (from version.json)
    let deployments = [];
    try {
      const versionFile = path.join(__dirname, "..", "version.json");
      if (fs.existsSync(versionFile)) {
        const version = JSON.parse(fs.readFileSync(versionFile, "utf-8"));
        deployments.push({
          commit: (version.commit || "").substring(0, 7),
          branch: version.branch || "unknown",
          deployed_at: version.deployed_at
        });
      }
    } catch {}
    
    res.json({
      health: {
        score: healthScore,
        cpu: cpuPct,
        memory: memPct,
        disk: diskPct
      },
      toolStats: {
        calls: 0, // Will be populated from /api/stats on frontend
        successRate: 0,
        avgTime: 0
      },
      storage: {
        kvCount,
        logSize,
        convCount
      },
      sessions: {
        mcpClients,
        mcpSessionDetails,
        agentStatus,
        cronJobs,
        activeWatches
      },
      recentErrors,
      deployments
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/api/llm", (req, res) => {
  try {
    http.get("http://127.0.0.1:11434/api/tags", (r) => {
      let data = "";
      r.on("data", (c) => data += c);
      r.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models || []).map(m => ({
            name: m.name,
            size: (m.size / 1073741824).toFixed(2) + "GB",
            modified: m.modified_at
          }));
          if (models.length === 0) {
            res.json({ status: "no_models", models: [] });
          } else {
            res.json({ status: "ok", models });
          }
        } catch { res.json({ status: "unreachable", error: "parse error" }); }
      });
    }).on("error", (e) => res.json({ status: "unreachable", error: e.message }));
  } catch (e) {
    res.json({ status: "unreachable", error: e.message });
  }
});

app.get("/api/services", (req, res) => {
  const services = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent", "ollama"];
  const status = {};
  for (const svc of services) {
    try {
      status[svc] = execSync(`systemctl is-active ${svc}`, { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
      status[svc] = "inactive";
    }
  }
  res.json({ services: status });
});

app.post("/api/quick-actions/:action", (req, res) => {
  const action = req.params.action;
  try {
    if (action === "health-check") {
      const services = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent", "ollama"];
      const serviceStatus = {};
      for (const svc of services) {
        try {
          serviceStatus[svc] = execSync(`systemctl is-active ${svc}`, { encoding: "utf-8", timeout: 3000 }).trim();
        } catch {
          serviceStatus[svc] = "inactive";
        }
      }
      const uptime = exec("uptime -p");
      const load = exec("cat /proc/loadavg | awk '{print $1,$2,$3}'");
      const disk = exec("df -h / | tail -1 | awk '{print $5 \" used, \" $4 \" free\"}'");
      const memory = exec("free -h | awk '/Mem:/ {print $3 \"/\" $2 \" used\"}'");
      auditLog(req, "quick-action.health-check", {});
      return res.json({ ok: true, action, result: { services: serviceStatus, uptime, load, disk, memory } });
    }

    if (action === "recent-failures") {
      const failures = dbStore.readToolLogs(200).filter(entry => !entry.ok).slice(0, 8).map(entry => ({
        time: entry.t,
        tool: entry.n,
        source: entry.src || "unknown",
        summary: (entry.s || "").slice(0, 240)
      }));
      auditLog(req, "quick-action.recent-failures", { count: failures.length });
      return res.json({ ok: true, action, result: { failures } });
    }

    if (action === "deployment") {
      const versionFile = path.join(__dirname, "..", "version.json");
      const version = fs.existsSync(versionFile) ? JSON.parse(fs.readFileSync(versionFile, "utf-8")) : {};
      auditLog(req, "quick-action.deployment", {});
      return res.json({ ok: true, action, result: {
        commit: version.commit || "unknown",
        branch: version.branch || "unknown",
        remote: version.remote_url || "unknown",
        deployedAt: version.deployed_at || "unknown"
      } });
    }

    if (action === "service-logs") {
      const allowedServices = new Set(["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"]);
      const service = String(req.body?.service || "sidekick-mcp");
      if (!allowedServices.has(service)) return res.status(400).json({ ok: false, error: "Unsupported service" });
      const logs = execSync(`sudo -n /usr/bin/journalctl -u ${service} | tail -40`, { encoding: "utf-8", timeout: 5000 }).trim();
      auditLog(req, "quick-action.service-logs", { service });
      return res.json({ ok: true, action, result: { service, logs } });
    }

    if (action === "restart-agent") {
      execSync("sudo systemctl restart sidekick-agent", { encoding: "utf-8", timeout: 10000 });
      const status = exec("systemctl is-active sidekick-agent");
      auditLog(req, "quick-action.restart-agent", { status });
      return res.json({ ok: status === "active", action, result: { service: "sidekick-agent", status } });
    }

    res.status(404).json({ ok: false, error: "Unknown quick action" });
  } catch (error) {
    logError(req.originalUrl, 500, error, "mission", req.headers["user-agent"]);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/config", (req, res) => {
  const sensitive = ["API_KEY", "PASS", "SECRET", "TOKEN", "PASSWORD"];
  const config = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SIDEKICK_") && !key.startsWith("GROQ_") && !key.startsWith("OLLAMA_")) continue;
    const isSensitive = sensitive.some(s => key.includes(s));
    config[key] = isSensitive ? "***redacted***" : (value || "");
  }
  res.json({ config });
});

app.put("/api/kv/:key", (req, res) => {
  try {
    const { value, project } = req.body || {};
    const kv = readKV();
    const now = new Date().toISOString();
    const existing = kv[req.params.key];
    
    if (existing && typeof existing === 'object' && 'value' in existing) {
      kv[req.params.key] = {
        value: value,
        project: project !== undefined ? project : existing.project,
        source: existing.source,
        created: existing.created,
        updated: now
      };
    } else {
      kv[req.params.key] = {
        value: value,
        project: project || null,
        source: "dashboard",
        created: now,
        updated: now
      };
    }
    
    writeKV(kv);
    auditLog(req, 'kv.update', { value_length: value?.length, project });
    res.json({ ok: true });
  } catch { res.status(400).json({ error: "invalid body" }); }
});

app.get("/api/kv/projects", (req, res) => {
  const kv = readKV();
  const projects = new Set();
  for (const entry of Object.values(kv)) {
    if (typeof entry === 'object' && entry !== null && 'project' in entry) {
      projects.add(entry.project);
    }
  }
  res.json({ projects: Array.from(projects) });
});

app.delete("/api/kv/:key", (req, res) => {
  const kv = readKV();
  delete kv[req.params.key];
  writeKV(kv);
  auditLog(req, 'kv.delete', { key: req.params.key });
  res.json({ ok: true });
});

app.get("/api/stats", (req, res) => {
  const now = new Date();
  const since = req.query.since || new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0
  )).toISOString();
  const until = req.query.until || new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0
  )).toISOString();
  const logs = dbStore.queryToolLogs({
    since,
    until,
    limit: 10000
  });
  const stats = {};
  for (const entry of logs) {
    const name = entry.n;
    if (!stats[name]) stats[name] = { count: 0, ok: 0, fail: 0, totalMs: 0 };
    stats[name].count++;
    if (entry.ok) stats[name].ok++; else stats[name].fail++;
    stats[name].totalMs += (entry.d || 0);
  }
  const result = Object.entries(stats).map(([name, s]) => ({
    name,
    count: s.count,
    ok: s.ok,
    fail: s.fail,
    avgMs: Math.round(s.totalMs / s.count)
  })).sort((a, b) => b.count - a.count);
  res.json({ stats: result });
});

app.get("/api/tools", (req, res) => {
  res.json({ tools: getToolDefsForSource("dashboard") });
});

app.get("/api/tool-policy", (req, res) => {
  let records = getToolDefsForSource("dashboard");
  if (req.query.name) records = records.filter(tool => tool.name === req.query.name);
  if (req.query.name && records.length === 0) return res.status(404).json({ ok: false, error: "Tool not found: " + req.query.name });
  const limit = Number.parseInt(req.query.limit || "100", 10);
  records = records.slice(0, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 100);
  const sources = String(req.query.source || "mcp,dashboard,agent").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const decisions = buildPolicyInspection(records, sources);
  res.json({ total: decisions.length, sources, summary: summarizePolicyInspection(decisions), decisions });
});

app.get("/api/tool-categories", (req, res) => {
  res.json({ categories: getToolCategoriesWithTools("dashboard") });
});

app.get("/api/approvals", (req, res) => {
  res.json({ ok: true, approvals: listApprovals({ status: req.query.status, limit: req.query.limit }) });
});

app.post("/api/approvals/:id/approve", async (req, res) => {
  try {
    auditLog(req, "approval.approve", { id: req.params.id });
    const result = await resolveApproval(req.params.id, "approve", "dashboard");
    res.json({ ok: !result.isError, result: result.content?.[0]?.text || "" });
  } catch (error) {
    logError(req.originalUrl, 500, error, "approvals", req.headers["user-agent"]);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/approvals/:id/reject", async (req, res) => {
  try {
    auditLog(req, "approval.reject", { id: req.params.id });
    const result = await resolveApproval(req.params.id, "reject", "dashboard");
    res.json({ ok: !result.isError, result: result.content?.[0]?.text || "" });
  } catch (error) {
    logError(req.originalUrl, 500, error, "approvals", req.headers["user-agent"]);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/knowledge", (req, res) => {
  try {
    const db = dbStore.getDb();
    const category = req.query.category;
    const limit = parseInt(req.query.limit) || 50;
    
    let rows;
    if (category) {
      rows = db.prepare(`
        SELECT id, category, title, tags, updated_at
        FROM knowledge
        WHERE enabled = 1 AND category = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(category, limit);
    } else {
      rows = db.prepare(`
        SELECT id, category, title, tags, updated_at
        FROM knowledge
        WHERE enabled = 1
        ORDER BY category, updated_at DESC
        LIMIT ?
      `).all(limit);
    }
    
    res.json({ ok: true, knowledge: rows });
  } catch (error) {
    res.json({ ok: false, error: error.message, knowledge: [] });
  }
});

app.get("/api/memories", (req, res) => {
  try {
    const { project, type, include_disabled, limit, query } = req.query;
    const options = {
      limit: parseInt(limit) || 100,
      includeDisabled: include_disabled === "true"
    };
    if (project) options.project = project;
    if (type) options.type = type;
    if (query) options.query = query;

    const memories = dbStore.searchMemories(options);
    const formatted = memories.map(m => ({
      id: m.id,
      type: m.type,
      project: m.project,
      content: m.content,
      summary: m.summary,
      tags: m.tags,
      confidence: m.confidence,
      enabled: m.enabled,
      automatic: m.automatic,
      times_confirmed: m.times_confirmed,
      state: m.metadata?.state || "active",
      created_at: m.created_at,
      updated_at: m.updated_at,
      last_seen_at: m.last_seen_at
    }));
    res.json({ ok: true, memories: formatted, count: formatted.length });
  } catch (error) {
    res.json({ ok: false, error: error.message, memories: [] });
  }
});

app.get("/api/memories/projects", (req, res) => {
  try {
    const db = dbStore.getDb();
    const rows = db.prepare(`
      SELECT DISTINCT project FROM memories
      WHERE project IS NOT NULL AND project != ''
      ORDER BY project
    `).all();
    res.json({ ok: true, projects: rows.map(r => r.project) });
  } catch (error) {
    res.json({ ok: false, error: error.message, projects: [] });
  }
});

app.get("/api/memories/types", (req, res) => {
  try {
    const db = dbStore.getDb();
    const rows = db.prepare(`
      SELECT DISTINCT type FROM memories
      ORDER BY type
    `).all();
    res.json({ ok: true, types: rows.map(r => r.type) });
  } catch (error) {
    res.json({ ok: false, error: error.message, types: [] });
  }
});

app.post("/api/memories/:id/disable", (req, res) => {
  try {
    const success = dbStore.disableMemory(req.params.id);
    auditLog(req, "memory_disable", { id: req.params.id });
    res.json({ ok: success });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.post("/api/memories/:id/enable", (req, res) => {
  try {
    const db = dbStore.getDb();
    const result = db.prepare(`
      UPDATE memories SET enabled = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.params.id);
    auditLog(req, "memory_enable", { id: req.params.id });
    res.json({ ok: result.changes > 0 });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.delete("/api/memories/:id", (req, res) => {
  try {
    const db = dbStore.getDb();
    const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(req.params.id);
    auditLog(req, "memory_delete", { id: req.params.id });
    res.json({ ok: result.changes > 0 });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.post("/api/memories/export", (req, res) => {
  try {
    const { project, type, include_disabled } = req.body || {};
    const options = {};
    if (project) options.project = project;
    if (type) options.type = type;
    if (include_disabled === false) options.includeDisabled = false;

    const result = dbStore.exportMemories(options);
    auditLog(req, "memory_export", { count: result.count, project, type });
    res.json({ ok: true, data: result });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.post("/api/memories/import", (req, res) => {
  try {
    const { data, on_conflict, preserve_ids } = req.body || {};
    const options = {
      onConflict: on_conflict || "merge",
      preserveIds: preserve_ids === true
    };
    const result = dbStore.importMemories(data, options);
    auditLog(req, "memory_import", { imported: result.imported, updated: result.updated, skipped: result.skipped });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/api/memories/stats", (req, res) => {
  try {
    const stats = dbStore.getMemoryStats();
    res.json({ ok: true, stats });
  } catch (error) {
    res.json({ ok: false, error: error.message, stats: null });
  }
});

app.post("/api/memories/expire", (req, res) => {
  try {
    const { stale_days } = req.body || {};
    const result = dbStore.expireStaleMemories({ staleDays: stale_days });
    auditLog(req, "memory_expire", { expired: result.expired, stale_days });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/api/sync/identity", (req, res) => {
  try {
    const machineId = dbStore.getMachineId();
    const userId = dbStore.getUserId();
    res.json({ ok: true, machine_id: machineId, user_id: userId });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.post("/api/sync/identity", (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id || typeof user_id !== "string") {
      return res.json({ ok: false, error: "user_id required" });
    }
    dbStore.setUserId(user_id);
    auditLog(req, "sync_set_user_id", { user_id });
    res.json({ ok: true, user_id });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/api/sync/export", (req, res) => {
  try {
    const { project, since, include_disabled } = req.query;
    const options = {};
    if (project) options.project = project;
    if (since) options.since = since;
    if (include_disabled === "false") options.includeDisabled = false;
    
    const data = dbStore.exportForSync(options);
    auditLog(req, "sync_export", { count: data.count, project, since });
    res.json({ ok: true, data });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.post("/api/sync/import", (req, res) => {
  try {
    const { data, strategy, preserve_ids } = req.body || {};
    const options = {
      strategy: strategy || "newest",
      preserveIds: preserve_ids === true
    };
    const result = dbStore.importFromSync(data, options);
    auditLog(req, "sync_import", { 
      imported: result.imported, 
      conflicts: result.conflicts, 
      strategy 
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/api/sync/diff", (req, res) => {
  try {
    const { since } = req.query;
    if (!since) {
      return res.json({ ok: false, error: "since parameter required" });
    }
    const diff = dbStore.getSyncDiff(since);
    res.json({ ok: true, ...diff });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/api/procedures", (req, res) => {
  const proceduresFile = path.join(DATA_DIR, "procedures.json");
  try {
    if (!fs.existsSync(proceduresFile)) {
      return res.json({ ok: true, procedures: [] });
    }
    const data = JSON.parse(fs.readFileSync(proceduresFile, "utf-8"));
    const procedures = Object.values(data).map(p => ({
      name: p.name,
      description: p.description,
      steps: p.steps || [],
      parameters: p.parameters || {},
      triggerPhrases: p.triggerPhrases || [],
      createdAt: p.createdAt,
      lastUsed: p.lastUsed,
      useCount: p.useCount || 0
    }));
    res.json({ ok: true, procedures });
  } catch (e) {
    res.json({ ok: false, error: e.message, procedures: [] });
  }
});

function requireDashboardTool(req, res, toolName) {
  const policyError = enforceToolPolicy(toolName, "dashboard");
  if (!policyError) return true;
  auditLog(req, "tool.policy_block", { tool: toolName, reason: policyError.content[0].text });
  res.status(403).json({ ok: false, error: policyError.content[0].text });
  return false;
}

// Database API endpoints
app.get("/api/db/schema", (req, res) => {
  if (!requireDashboardTool(req, res, "sidekick_db_schema")) return;
  try {
    const db = dbStore.getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const result = {};
    for (const t of tables) {
      const columns = db.prepare(`PRAGMA table_info("${t.name}")`).all();
      const indexes = db.prepare(`PRAGMA index_list("${t.name}")`).all();
      const count = db.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get();
      result[t.name] = { columns, indexes, rowCount: count.count };
    }
    res.json({ ok: true, schema: result });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/db/query", (req, res) => {
  if (!requireDashboardTool(req, res, "sidekick_db_query")) return;
  try {
    const { sql, params, readonly, limit } = req.body || {};
    if (!sql) return res.json({ ok: false, error: "No SQL provided" });
    const start = Date.now();
    const rows = dbStore.executeQuery(sql, params || [], {
      readonly: readonly !== false,
      limit: limit || 1000
    });
    const duration = Date.now() - start;
    res.json({ ok: true, rows, duration, count: rows.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/db/stats", (req, res) => {
  if (!requireDashboardTool(req, res, "sidekick_db_stats")) return;
  try {
    const db = dbStore.getDb();
    const dbPath = path.join(DATA_DIR, "sidekick.db");
    const stats = fs.statSync(dbPath);
    const walMode = db.prepare("PRAGMA journal_mode").get();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const pageCount = db.prepare("PRAGMA page_count").get();
    const pageSize = db.prepare("PRAGMA page_size").get();
    const dbSize = (pageCount?.page_count || 0) * (pageSize?.page_size || 4096);
    res.json({ ok: true, size: stats.size, tableCount: tables.length, walMode: walMode?.journal_mode, dbSize });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/db/backup", (req, res) => {
  if (!requireDashboardTool(req, res, "sidekick_db_backup")) return;
  try {
    const backupDir = path.join(DATA_DIR, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `sidekick-${timestamp}.db`);
    const srcDb = dbStore.getDb();
    srcDb.backup(backupPath).then(() => {
      auditLog(req, 'db.backup', { path: backupPath });
      res.json({ ok: true, path: backupPath });
    }).catch(e => res.json({ ok: false, error: e.message }));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/db/search", (req, res) => {
  if (!requireDashboardTool(req, res, "sidekick_db_search")) return;
  try {
    const { q, limit } = req.query;
    if (!q) return res.json({ ok: false, error: "No query provided" });
    const db = dbStore.getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const results = {};
    const maxResults = parseInt(limit) || 50;
    for (const t of tables) {
      const columns = db.prepare(`PRAGMA table_info("${t.name}")`).all();
      const textCols = columns.filter(c => c.type === "TEXT" || c.type === "").map(c => c.name);
      if (textCols.length === 0) continue;
      const whereClause = textCols.map(c => `${c} LIKE ?`).join(" OR ");
      const params = textCols.map(() => `%${q}%`);
      const rows = db.prepare(`SELECT * FROM "${t.name}" WHERE ${whereClause} LIMIT ?`).all(...params, maxResults);
      if (rows.length > 0) results[t.name] = rows;
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/db/migrations", (req, res) => {
  if (!requireDashboardTool(req, res, "sidekick_db_migrate")) return;
  try {
    const db = dbStore.getDb();
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const currentVersion = meta ? parseInt(meta.value) : 0;
    const migrationsDir = path.join(__dirname, "..", "migrations");
    let migrations = [];
    if (fs.existsSync(migrationsDir)) {
      migrations = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith(".sql"))
        .map(f => {
          const match = f.match(/^(\d+)/);
          const version = match ? parseInt(match[1]) : 0;
          return { file: f, version, applied: version <= currentVersion };
        })
        .sort((a, b) => a.version - b.version);
    }
    res.json({ ok: true, currentVersion, migrations });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.delete("/api/logs", (req, res) => {
  try { dbStore.clearToolLogs(); } catch {}
  auditLog(req, 'logs.clear', {});
  res.json({ ok: true });
});

app.delete("/api/kv", (req, res) => {
  try { dbStore.clearKV(); } catch {}
  auditLog(req, 'kv.clear', {});
  res.json({ ok: true });
});

app.delete("/api/conversations", (req, res) => {
  const dir = path.join(DATA_DIR, "conversations");
  try {
    fs.readdirSync(dir).filter(f => f.endsWith(".json")).forEach(f => {
      fs.unlinkSync(path.join(dir, f));
    });
  } catch {}
  auditLog(req, 'conversations.clear', {});
  res.json({ ok: true });
});

app.delete("/api/data", (req, res) => {
  try {
    dbStore.clearToolLogs();
    dbStore.clearKV();
    const dir = path.join(DATA_DIR, "conversations");
    fs.readdirSync(dir).filter(f => f.endsWith(".json")).forEach(f => {
      fs.unlinkSync(path.join(dir, f));
    });
  } catch {}
  auditLog(req, 'data.clear', {});
  res.json({ ok: true });
});

// Error logging endpoint (for frontend errors)
app.post('/api/internal/error-log', (req, res) => {
  try {
    const entry = req.body || {};
    logError(entry.url, entry.status, entry.error, entry.page, entry.userAgent);
  } catch {}
  res.json({ ok: true });
});

// Webhook receiver endpoint
function loadWebhooks() {
  return dbStore.loadDocument("webhooks", []);
}
function saveWebhooks(webhooks) {
  dbStore.setDocument("webhooks", webhooks);
}

app.post('/api/webhook/:source', (req, res) => {
  try {
    const payload = req.body || {};
    const webhooks = loadWebhooks();
    const webhook = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      source: req.params.source,
      timestamp: new Date().toISOString(),
      payload
    };
    webhooks.push(webhook);
    if (webhooks.length > 1000) webhooks.splice(0, webhooks.length - 1000);
    saveWebhooks(webhooks);
    res.json({ ok: true, id: webhook.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Agent Proxy ---

function proxyAgent(req, res, method, body) {
  const headers = { "Content-Type": "application/json" };
  if (body) headers["Content-Length"] = Buffer.byteLength(body);
  const opts = {
    hostname: "127.0.0.1",
    port: AGENT_PORT,
    path: req.originalUrl,
    method: method,
    headers: headers
  };
  const proxy = http.request(opts, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on("error", (e) => {
    res.status(502).json({ error: "Agent bridge unavailable: " + e.message });
  });
  if (body) proxy.write(body);
  proxy.end();
}

app.post("/api/agent/run", (req, res) => {
  const body = JSON.stringify(req.body);
  proxyAgent(req, res, "POST", body);
});

app.get("/api/agent/stream/:taskId", (req, res) => {
  proxyAgent(req, res, "GET");
});

app.get("/api/agent/history", (req, res) => {
  proxyAgent(req, res, "GET");
});

app.get("/api/agent/run/:id", (req, res) => {
  proxyAgent(req, res, "GET");
});

// --- Frontend ---

app.get("/", (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf-8")
    .replace("__VPS_IP__", VPS_IP);
  res.set("Content-Type", "text/html; charset=utf-8").send(html);
});

app.listen(PORT, "0.0.0.0", () => {
  seedKV();
  console.log("Sidekick dashboard listening on http://0.0.0.0:" + PORT);
});
