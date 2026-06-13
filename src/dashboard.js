require("./env");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { TOOL_DEFS } = require("./tools");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const PORT = parseInt(process.env.SIDEKICK_DASHBOARD_PORT || "4098", 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
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
    if (origin && !origin.includes(host)) {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }
  next();
});

if (DASHBOARD_USER && DASHBOARD_PASS) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/agent/stream/')) return next();
    if (req.path === "/") return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Basic ")) {
      res.set("WWW-Authenticate", 'Basic realm="Sidekick Dashboard"');
      return res.status(401).send("Authentication required");
    }
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const [user, pass] = decoded.split(":");
    if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) return next();
    res.set("WWW-Authenticate", 'Basic realm="Sidekick Dashboard"');
    res.status(401).send("Authentication required");
  });
}

// --- API ---

function readLogs() {
  const f = path.join(DATA_DIR, "log.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).reverse();
}

function readKV() {
  const f = path.join(DATA_DIR, "kvstore.json");
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch { return {}; }
}

function writeKV(data) {
  const f = path.join(DATA_DIR, "kvstore.json");
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
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
          res.json({ available: models.length > 0, models });
        } catch { res.json({ available: false, error: "parse error" }); }
      });
    }).on("error", (e) => res.json({ available: false, error: e.message }));
  } catch (e) {
    res.json({ available: false, error: e.message });
  }
});

app.get("/api/services", (req, res) => {
  const services = ["sidekick-mcp", "sidekick-agent", "ollama"];
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
  const logs = readLogs();
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
  res.json({ tools: TOOL_DEFS });
});

app.delete("/api/logs", (req, res) => {
  const f = path.join(DATA_DIR, "log.jsonl");
  try { fs.writeFileSync(f, "", "utf-8"); } catch {}
  auditLog(req, 'logs.clear', {});
  res.json({ ok: true });
});

app.delete("/api/kv", (req, res) => {
  const f = path.join(DATA_DIR, "kvstore.json");
  try { fs.writeFileSync(f, "{}", "utf-8"); } catch {}
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
    fs.writeFileSync(path.join(DATA_DIR, "log.jsonl"), "", "utf-8");
    fs.writeFileSync(path.join(DATA_DIR, "kvstore.json"), "{}", "utf-8");
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
const WEBHOOK_FILE = path.join(DATA_DIR, "webhooks.json");
function loadWebhooks() {
  if (!fs.existsSync(WEBHOOK_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WEBHOOK_FILE, "utf-8"));
  } catch (e) {
    return [];
  }
}
function saveWebhooks(webhooks) {
  fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(webhooks, null, 2));
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
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sidekick Dashboard</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px}
h1{font-size:1.4rem;margin-bottom:8px;color:#58a6ff}
nav{display:flex;gap:8px;margin-bottom:12px}
nav a{padding:6px 16px;border-radius:6px;text-decoration:none;font-size:.85rem;color:#8b949e;background:#161b22;border:1px solid #21262d;cursor:pointer}
nav a.active{color:#58a6ff;border-color:#58a6ff;background:#0d1117}
.page{display:none}
.page.active{display:block}
.sub{color:#8b949e;font-size:.85rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:16px}
.card .label{font-size:.75rem;color:#8b949e;text-transform:uppercase}
.card .value{font-size:1.3rem;font-weight:600;margin-top:4px}
.card .value.ok{color:#3fb950}
.card .value.warn{color:#d29922}
.status-row{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.status-box{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:8px 12px;flex:1;min-width:120px}
.status-box .s-label{font-size:.65rem;color:#6e7681;text-transform:uppercase}
.status-box .s-val{font-size:.85rem;font-weight:600;margin-top:2px}
.status-box .s-val.ok{color:#3fb950}
.status-box .s-val.warn{color:#d29922}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
@media(max-width:800px){.two-col,.three-col{grid-template-columns:1fr}}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px}
.section-title{font-size:.85rem;color:#8b949e;margin-bottom:8px;text-transform:uppercase}
.log-entry{padding:8px 0;border-bottom:1px solid #21262d;font-size:.82rem;display:flex;gap:12px;align-items:flex-start}
.log-entry:last-child{border-bottom:none}
.log-entry.error{background:#1a0a0a;margin:0 -16px;padding:8px 16px;border-left:3px solid #f85149}
.log-time{color:#8b949e;white-space:nowrap;font-family:monospace;min-width:140px}
.log-name{color:#58a6ff;font-weight:500;min-width:130px;font-family:monospace}
.log-ok{color:#3fb950}
.log-fail{color:#f85149}
.log-summary{color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.log-args{color:#7ee787;font-family:monospace;font-size:.78rem;word-break:break-all;max-height:60px;overflow-y:auto;flex:1}
.kv-entry{padding:8px 0;border-bottom:1px solid #21262d;font-size:.82rem;display:flex;gap:8px;align-items:flex-start}
.kv-entry:last-child{border-bottom:none}
.kv-key{color:#ffa657;font-family:monospace;font-weight:500;min-width:180px;word-break:break-all}
.kv-val{color:#c9d1d9;font-family:monospace;word-break:break-all;flex:1}
.kv-project{background:#21262d;color:#58a6ff;padding:2px 8px;border-radius:4px;font-size:.75rem;font-family:monospace;white-space:nowrap}
.kv-actions{display:flex;gap:4px;flex-shrink:0}
.kv-actions button{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:.75rem}
.kv-actions button:hover{background:#30363d;color:#c9d1d9}
.kv-actions button.del:hover{background:#da3633;color:#fff;border-color:#da3633}
.empty{color:#484f58;font-style:italic;padding:12px 0}
.agent-goal{width:100%;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:.9rem;margin-bottom:8px;resize:vertical}
.agent-goal:focus{outline:none;border-color:#58a6ff}
.btn{background:#238636;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:.85rem}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-danger{background:#da3633}
.btn-sm{padding:4px 12px;font-size:.78rem}
.btn-outline{background:transparent;border:1px solid #30363d;color:#8b949e}
.btn-outline:hover{border-color:#58a6ff;color:#58a6ff}
.agent-log{padding:12px;background:#0d1117;border:1px solid #21262d;border-radius:6px;font-family:monospace;font-size:.8rem;max-height:500px;overflow-y:auto;margin-top:8px;white-space:pre-wrap;line-height:1.5}
.agent-step{color:#58a6ff;font-weight:500}
.agent-ok{color:#3fb950}
.agent-err{color:#f85149}
.agent-done{color:#d29922}
.llm-card{display:flex;align-items:center;gap:12px;padding:12px;background:#161b22;border:1px solid #21262d;border-radius:8px;margin-bottom:8px}
.llm-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.llm-dot.on{background:#3fb950;box-shadow:0 0 8px #3fb95066}
.llm-dot.off{background:#484f58}
.llm-name{font-weight:500;color:#c9d1d9}
.llm-size{color:#8b949e;font-size:.8rem}
.service-indicator{display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:.8rem}
.service-indicator i{font-size:.9rem}
.service-indicator.on{color:#3fb950}
.service-indicator.off{color:#f85149}
.config-entry{padding:6px 0;border-bottom:1px solid #21262d;font-size:.82rem;display:flex;gap:12px}
.config-entry:last-child{border-bottom:none}
.config-key{color:#ffa657;font-family:monospace;font-weight:500;min-width:200px}
.config-val{color:#c9d1d9;font-family:monospace;word-break:break-all;flex:1}
.config-val.redacted{color:#8b949e;font-style:italic}
.history-item{padding:8px 0;border-bottom:1px solid #21262d;font-size:.82rem;cursor:pointer;display:flex;gap:8px;align-items:center}
.history-item:hover{background:#161b22}
.history-item:last-child{border-bottom:none}
.history-detail{padding:8px 0 8px 20px;background:#0d1117;border-left:2px solid #21262d;margin:4px 0;font-family:monospace;font-size:.78rem;white-space:pre-wrap;line-height:1.4;max-height:400px;overflow-y:auto}
.search-bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.search-bar input,.search-bar select{padding:6px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:.82rem}
.search-bar input:focus,.search-bar select:focus{outline:none;border-color:#58a6ff}
.search-bar input{flex:1;min-width:200px}
.session-group{margin-bottom:16px;border:1px solid #21262d;border-radius:8px;overflow:hidden}
.session-header{padding:8px 16px;background:#161b22;cursor:pointer;display:flex;gap:12px;align-items:center;font-size:.82rem}
.session-header:hover{background:#1c2128}
.session-header .session-time{color:#58a6ff;font-family:monospace;font-weight:500}
.session-header .session-count{color:#8b949e}
.session-header .session-src{color:#bc8cff;font-size:.75rem}
.session-body{padding:0 16px;display:none}
.session-body.open{display:block}
.stats-table{width:100%;border-collapse:collapse;font-size:.82rem}
.stats-table th{text-align:left;padding:8px 12px;border-bottom:2px solid #21262d;color:#8b949e;font-weight:500;text-transform:uppercase;font-size:.75rem}
.stats-table td{padding:8px 12px;border-bottom:1px solid #21262d}
.stats-table tr:hover{background:#161b22}
.stats-bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden;min-width:60px}
.stats-bar-fill{height:100%;border-radius:3px}
.stats-bar-fill.ok{background:#3fb950}
.stats-bar-fill.fail{background:#f85149}
.stats-bar-fill.warn{background:#d29922}
.load-more{display:block;width:100%;padding:8px;background:transparent;border:1px solid #21262d;border-radius:6px;color:#58a6ff;cursor:pointer;font-size:.82rem;margin-top:8px}
.load-more:hover{background:#161b22;border-color:#58a6ff}
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.active{display:flex}
.modal{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto}
.modal h3{color:#58a6ff;margin-bottom:16px}
.modal textarea{width:100%;min-height:200px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-family:monospace;font-size:.82rem;resize:vertical}
.modal textarea:focus{outline:none;border-color:#58a6ff}
.modal-actions{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
footer{text-align:center;font-size:.75rem;color:#484f58;padding:24px 0}
.kv-entry{display:flex;flex-direction:column;gap:8px;padding:12px;border-bottom:1px solid #21262d}
.kv-entry:last-child{border-bottom:none}
.kv-header{display:flex;justify-content:space-between;align-items:center}
.kv-key{font-weight:600;font-family:monospace;color:#c9d1d9}
.kv-badges{display:flex;gap:6px}
.kv-source{font-size:11px;padding:2px 8px;border-radius:3px;background:#21262d;color:#8b949e}
.kv-source.mcp{background:#2d4a2d;color:#7ee787}
.kv-source.agent{background:#4a2d4a;color:#d2a8ff}
.kv-source.dashboard{background:#2d3a4a;color:#79c0ff}
.kv-value-preview{background:#161b22;padding:8px 12px;border-radius:4px;font-family:monospace;font-size:12px;cursor:pointer;white-space:pre-wrap;word-break:break-all;max-height:100px;overflow:hidden;position:relative}
.kv-value-preview:hover{background:#1c2128}
.kv-value-preview.expanded{max-height:none}
.kv-value-preview::after{content:'Click to expand';position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,#161b22);padding:20px 12px 8px;text-align:center;font-size:11px;color:#8b949e;opacity:0;transition:opacity 0.2s}
.kv-value-preview:hover::after{opacity:1}
.kv-value-preview.expanded::after{display:none}
.kv-timestamps{display:flex;gap:16px;font-size:11px;color:#8b949e}
.kv-timestamps span{display:flex;align-items:center;gap:4px}
.kv-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:1000}
.kv-modal-content{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:24px;max-width:800px;max-height:80vh;overflow:auto;width:90%}
.kv-modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.kv-modal-header h3{color:#58a6ff;margin:0}
.kv-modal-value{background:#161b22;padding:16px;border-radius:4px;font-family:monospace;font-size:13px;white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto}
.log-entry{display:flex;flex-direction:column;gap:8px;padding:12px;border-bottom:1px solid #21262d;position:relative}
.log-entry.error{background:rgba(248,81,73,0.05);border-left:3px solid #f85149}
.log-header{display:flex;justify-content:space-between;align-items:center}
.log-time{font-size:11px;color:#8b949e;font-family:monospace}
.log-tool{font-weight:600;font-family:monospace;color:#58a6ff}
.log-status{font-size:11px;padding:2px 8px;border-radius:3px;font-weight:600}
.log-status.ok{background:#2d4a2d;color:#7ee787}
.log-status.fail{background:#4a2d2d;color:#f85149}
.log-args{background:#161b22;padding:8px 12px;border-radius:4px;font-family:monospace;font-size:12px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all}
.log-result{background:#161b22;padding:8px 12px;border-radius:4px;font-family:monospace;font-size:12px;color:#8b949e;cursor:pointer;max-height:100px;overflow:hidden;position:relative;white-space:pre-wrap;word-break:break-all}
.log-result:hover{background:#1c2128}
.log-result.expanded{max-height:none}
.log-result::after{content:'Click to expand';position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,#161b22);padding:20px 12px 8px;text-align:center;font-size:11px;opacity:0;transition:opacity 0.2s}
.log-result:hover::after{opacity:1}
.log-result.expanded::after{display:none}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:6px;color:#fff;font-size:.85rem;z-index:10000;opacity:0;transform:translateX(400px);transition:all 0.3s ease;max-width:400px;box-shadow:0 4px 6px rgba(0,0,0,0.3)}
.toast.show{opacity:1;transform:translateX(0)}
.toast-info{background:#1f6feb}
.toast-success{background:#238636}
.toast-warning{background:#d29922}
.toast-error{background:#da3633}
.tool-category-header{display:flex;align-items:center;gap:10px;padding:12px 0 8px;margin-top:8px;border-bottom:1px solid #21262d}
.tool-category-header i{font-size:1rem;width:20px;text-align:center}
.tool-category-header .cat-name{font-size:.9rem;font-weight:600;color:#c9d1d9}
.tool-category-header .cat-count{font-size:.75rem;color:#8b949e;background:#21262d;padding:2px 8px;border-radius:10px}
.tool-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;padding:8px 0}
.tool-card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:14px;cursor:pointer;transition:border-color 0.15s}
.tool-card:hover{border-color:#58a6ff}
.tool-card-name{font-family:monospace;font-weight:600;color:#58a6ff;font-size:.88rem;margin-bottom:4px}
.tool-card-desc{color:#8b949e;font-size:.8rem;line-height:1.4;margin-bottom:8px}
.tool-card-args{font-size:.75rem;color:#6e7681;font-family:monospace;word-break:break-all}
.tool-card-args .arg-name{color:#ffa657}
.tool-card-args .arg-opt{color:#484f58}
.tool-detail-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.tool-detail-overlay.active{display:flex}
.tool-detail{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;max-width:650px;width:90%;max-height:80vh;overflow-y:auto}
.tool-detail h3{color:#58a6ff;font-family:monospace;margin-bottom:8px}
.tool-detail .td-desc{color:#c9d1d9;font-size:.9rem;margin-bottom:16px;line-height:1.5}
.tool-detail .td-section{margin-bottom:12px}
.tool-detail .td-label{font-size:.75rem;color:#8b949e;text-transform:uppercase;margin-bottom:4px}
.tool-detail .td-args{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;font-family:monospace;font-size:.82rem}
.tool-detail .td-arg-row{padding:4px 0;border-bottom:1px solid #21262d}
.tool-detail .td-arg-row:last-child{border-bottom:none}
.tool-detail .td-arg-name{color:#ffa657;font-weight:500}
.tool-detail .td-arg-type{color:#8b949e;margin-left:8px}
.tool-card-stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;padding-top:6px;border-top:1px solid #21262d}
.tool-card-stats .stat-item{font-size:.72rem;color:#8b949e;font-family:monospace}
.tool-card-stats .stat-item i{margin-right:2px}
</style>
</head>
<body>
<div class="header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:12px;border-bottom:1px solid #21262d">
  <div>
    <h1 style="font-size:1.4rem;color:#58a6ff">Sidekick Dashboard <span id="serviceDots" style="font-size:.85rem;margin-left:12px"></span></h1>
    <div class="sub">${VPS_IP}</div>
  </div>
  <div class="sub" id="lastUpdate"></div>
</div>

<nav>
  <a class="active" onclick="showPage('system')" id="nav-system">System</a>
  <a onclick="showPage('activity')" id="nav-activity">Activity</a>
  <a onclick="showPage('data')" id="nav-data">Data</a>
  <a onclick="showPage('config')" id="nav-config">Config</a>
  <a onclick="showPage('agent')" id="nav-agent">Agent</a>
  <a onclick="showPage('tools')" id="nav-tools">Tools</a>
</nav>
<div class="status-row">
  <div class="status-box"><div class="s-label">Uptime</div><div class="s-val" id="s-uptime">...</div></div>
  <div class="status-box"><div class="s-label">CPU</div><div class="s-val" id="s-cpu">...</div></div>
  <div class="status-box"><div class="s-label">Memory</div><div class="s-val" id="s-memory">...</div></div>
  <div class="status-box"><div class="s-label">Disk</div><div class="s-val" id="s-disk">...</div></div>
</div>

<!-- System Page -->
<div class="page active" id="page-system">
  <div class="section-title" style="margin-bottom:8px">Local LLM</div>
  <div id="llmStatus"><div class="empty">Checking...</div></div>
  <div class="section-title" style="margin:16px 0 8px">Tool Usage</div>
  <div class="card" style="padding:0;overflow:hidden">
    <table class="stats-table" id="statsTable">
      <thead><tr><th>Tool</th><th>Calls</th><th>Success</th><th>Fail</th><th>Avg</th><th>Rate</th></tr></thead>
      <tbody id="statsBody"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
    </table>
  </div>
</div>

<!-- Activity Page -->
<div class="page" id="page-activity">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div class="section-title" style="margin:0">Activity Log (<span id="logCount">0</span>)</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-sm btn-outline" onclick="clearData('logs')" title="Clear activity log"><i class="fas fa-trash"></i> Clear Log</button>
      <button class="btn btn-sm btn-outline" onclick="clearData('all')" title="Clear all data"><i class="fas fa-trash-alt"></i> Clear All</button>
    </div>
  </div>
  <div class="search-bar">
    <input type="text" id="logSearch" placeholder="Search tool name, args, or output..." oninput="filterLogs()">
    <select id="logSourceFilter" onchange="filterLogs()">
      <option value="">All Sources</option>
      <option value="mcp">MCP</option>
      <option value="agent">Agent</option>
      <option value="unknown">Unknown</option>
    </select>
    <select id="logStatusFilter" onchange="filterLogs()">
      <option value="">All Status</option>
      <option value="ok">OK</option>
      <option value="fail">Failed</option>
    </select>
  </div>
  <div id="logList" style="max-height:600px;overflow-y:auto"></div>
</div>

<!-- Data Page -->
<div class="page" id="page-data">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div class="section-title" style="margin:0">Stored Data (<span id="kvCount">0</span>)</div>
    <button class="btn btn-sm btn-outline" onclick="clearData('kv')" title="Clear all KV data"><i class="fas fa-trash"></i> Clear KV</button>
  </div>
  <div class="search-bar">
    <input type="text" id="kvSearch" placeholder="Search keys or values..." oninput="filterKV()">
    <select id="kvProjectFilter" onchange="filterKV()">
      <option value="">All Projects</option>
    </select>
    <select id="kvAgeFilter" onchange="filterKV()">
      <option value="all">All Time</option>
      <option value="today">Today</option>
      <option value="week">This Week</option>
      <option value="month">This Month</option>
    </select>
  </div>
  <div class="card" id="kvList" style="max-height:600px;overflow-y:auto;padding:8px 16px"></div>
</div>

<!-- Config Page -->
<div class="page" id="page-config">
  <div class="section-title">Environment Configuration</div>
  <div class="card" id="configList" style="max-height:600px;overflow-y:auto;padding:8px 16px"></div>
</div>

<!-- Agent Page -->
<div class="page" id="page-agent">
  <div class="section-title">Run Agent Task</div>
  <textarea class="agent-goal" id="agentGoal" rows="3" placeholder="Describe what you want the agent to do...&#10;Example: check disk usage, store the result, and tell me the summary"></textarea>
  <div style="display:flex;gap:8px;margin-bottom:16px">
    <button class="btn" id="agentGo" onclick="runAgent()">Go</button>
    <button class="btn btn-danger" id="agentStop" onclick="stopAgent()" disabled>Stop</button>
  </div>
  <div class="section-title">Output</div>
  <div class="agent-log" id="agentLog"><span class="empty">Submit a task above</span></div>
  <div style="margin-top:16px">
    <div class="section-title" style="cursor:pointer" onclick="toggleHistory()">History ▾</div>
    <div id="agentHistory" style="display:none;margin-top:8px"></div>
  </div>
</div>

<!-- Tools Page -->
<div class="page" id="page-tools">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div class="section-title" style="margin:0">Tool Catalog (<span id="toolCount">0</span>)</div>
  </div>
  <div class="search-bar">
    <input type="text" id="toolSearch" placeholder="Search tools by name or description..." oninput="filterTools()">
    <select id="toolCategoryFilter" onchange="filterTools()">
      <option value="">All Categories</option>
    </select>
  </div>
  <div id="toolList"></div>
</div>

<!-- Edit Modal -->
<div class="modal-overlay" id="editModal">
  <div class="modal">
    <h3>Edit KV Entry</h3>
    <div style="margin-bottom:8px;color:#8b949e;font-size:.82rem">Key: <span id="editKey" style="color:#ffa657;font-family:monospace"></span></div>
    <div style="margin-bottom:8px;color:#8b949e;font-size:.82rem">Project: <input type="text" id="editProject" placeholder="Global (leave empty)" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;padding:4px 8px;font-family:monospace;font-size:.82rem;margin-left:8px"></div>
    <textarea id="editValue"></textarea>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeEditModal()">Cancel</button>
      <button class="btn" onclick="saveKVEdit()">Save</button>
    </div>
  </div>
</div>

<footer>refreshes every 10s</footer>

<script>
let currentPage = 'system';
let agentRunning = false;
let agentStream = null;
let expandedHistory = {};
let allLogs = [];
let allKV = [];
let logPage = 0;
const LOG_PAGE_SIZE = 50;
const SESSION_GAP_MS = 5 * 60 * 1000;
let allTools = [];

// Authentication helpers
function getAuthHeader() {
  return sessionStorage.getItem('sidekick_auth');
}

function clearAuth() {
  sessionStorage.removeItem('sidekick_auth');
}

function showAuthModal(onSuccess) {
  let modal = document.getElementById('auth-modal');
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = 'auth-modal';
    modal.innerHTML = \`
      <form method="dialog" style="max-width: 300px; padding: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; color: #c9d1d9;">
        <h3 style="margin-top: 0; color: #58a6ff;">Authentication Required</h3>
        <label style="display: block; margin: 10px 0 5px; font-size: .85rem;">Username:</label>
        <input type="text" id="auth-username" style="width: 100%; padding: 8px; margin-bottom: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9;" required>
        <label style="display: block; margin: 10px 0 5px; font-size: .85rem;">Password:</label>
        <input type="password" id="auth-password" style="width: 100%; padding: 8px; margin-bottom: 15px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9;" required>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button type="button" id="auth-cancel" style="padding: 8px 16px; background: #21262d; border: 1px solid #30363d; color: #c9d1d9; border-radius: 4px; cursor: pointer;">Cancel</button>
          <button type="submit" id="auth-submit" style="padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">Login</button>
        </div>
      </form>
    \`;
    document.body.appendChild(modal);

    document.getElementById('auth-cancel').addEventListener('click', () => {
      modal.close();
    });

    modal.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const user = document.getElementById('auth-username').value;
      const pass = document.getElementById('auth-password').value;
      const auth = btoa(user + ':' + pass);
      sessionStorage.setItem('sidekick_auth', auth);
      modal.close();
      if (onSuccess) onSuccess();
    });
  }

  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
  modal.showModal();
}

// Authenticated fetch wrapper - adds auth header and handles 401
function authFetch(url, options) {
  options = options || {};
  var headers = options.headers || {};
  var auth = getAuthHeader();
  if (auth) {
    headers['Authorization'] = 'Basic ' + auth;
  }
  options.headers = headers;
  if (!options.credentials) options.credentials = 'same-origin';

  return fetch(url, options).then(function(res) {
    if (res.status === 401) {
      clearAuth();
      showAuthModal(function() { location.reload(); });
      throw new Error('Authentication required');
    }
    return res;
  });
}

const TOOL_CATEGORIES = {
  'Core': { icon: 'fa-terminal', tools: ['sidekick_bash','sidekick_read','sidekick_write','sidekick_list','sidekick_search','sidekick_web_fetch','sidekick_llm'] },
  'Storage': { icon: 'fa-database', tools: ['sidekick_store','sidekick_get','sidekick_list_projects','sidekick_get_by_project'] },
  'Git & GitHub': { icon: 'fa-code-branch', tools: ['sidekick_git','sidekick_github'] },
  'Services': { icon: 'fa-cogs', tools: ['sidekick_process','sidekick_service'] },
  'Scheduling': { icon: 'fa-clock', tools: ['sidekick_cron','sidekick_delay'] },
  'Communication': { icon: 'fa-bell', tools: ['sidekick_notify','sidekick_webhook'] },
  'Context & Learning': { icon: 'fa-brain', tools: ['sidekick_context','sidekick_teach'] },
  'Data Pipeline': { icon: 'fa-filter', tools: ['sidekick_transform','sidekick_parse','sidekick_diff','sidekick_hash','sidekick_validate','sidekick_template','sidekick_extract','sidekick_anonymize','sidekick_diff_files'] },
  'Monitoring': { icon: 'fa-heartbeat', tools: ['sidekick_health','sidekick_status','sidekick_watch','sidekick_baseline','sidekick_snapshot','sidekick_timeline','sidekick_black_box','sidekick_netdiag'] },
  'Workflow': { icon: 'fa-tasks', tools: ['sidekick_queue','sidekick_retry','sidekick_orchestrate','sidekick_runbook'] },
  'Meta': { icon: 'fa-robot', tools: ['sidekick_evolve','sidekick_predict','sidekick_debug_tool','sidekick_fresheyes'] },
  'Efficiency': { icon: 'fa-bolt', tools: ['sidekick_batch','sidekick_cache','sidekick_summarize','sidekick_filter','sidekick_project','sidekick_tail','sidekick_find'] },
  'Security': { icon: 'fa-shield-alt', tools: ['sidekick_secret','sidekick_sandbox'] },
  'Development': { icon: 'fa-code', tools: ['sidekick_changelog','sidekick_depend'] },
  'Reliability': { icon: 'fa-plug', tools: ['sidekick_circuit'] },
  'Archive': { icon: 'fa-file-archive', tools: ['sidekick_archive'] }
};

function getToolCategory(toolName) {
  for (const [cat, info] of Object.entries(TOOL_CATEGORIES)) {
    if (info.tools.includes(toolName)) return cat;
  }
  return 'Other';
}

const SERVICE_ICONS = { 'sidekick-mcp': 'fa-server', 'sidekick-agent': 'fa-robot', 'ollama': 'fa-brain' };
const SERVICE_LABELS = { 'sidekick-mcp': 'MCP', 'sidekick-agent': 'Agent', 'ollama': 'Ollama' };
const SOURCE_ICONS = { 'agent': 'fa-robot', 'mcp': 'fa-plug', 'unknown': 'fa-circle-question' };
const SOURCE_COLORS = { 'agent': '#58a6ff', 'mcp': '#bc8cff', 'unknown': '#8b949e' };

// Toast notification system
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = \`toast toast-\${type}\`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// Centralized error handler
function apiError(url, error, status) {
  const messages = {
    401: 'Authentication required — please refresh the page',
    429: 'Rate limited — please wait before refreshing',
    502: 'Backend service unavailable',
    503: 'Service temporarily unavailable',
  };
  
  const msg = messages[status] || \`Request failed: \${error.message || 'Unknown error'}\`;
  showToast(msg, status >= 500 ? 'error' : 'warning');
  
  // Log to server (fire-and-forget)
  fetch('/api/internal/error-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      url,
      status,
      error: error.message || String(error),
      page: currentPage,
      userAgent: navigator.userAgent
    })
  }).catch(() => {}); // This one CAN silently fail
}

function $(id){return document.getElementById(id)}

function showPage(name){
  currentPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  $('page-' + name).classList.add('active');
  $('nav-' + name).classList.add('active');
  loadSystem();
  if (name === 'system') { loadLLM(); loadServices(); loadStats(); }
  if (name === 'activity') loadLogs();
  if (name === 'data') loadKV();
  if (name === 'config') loadConfig();
  if (name === 'tools') loadTools();
}

function fmtTime(iso){
  const d = new Date(iso);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return hour12 + ':' + m + ':' + s + '.' + ms + ' ' + ampm;
}

function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
}

function esc(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// -- Services -- //
function loadServices(){
  authFetch('/api/services').then(r=>r.json()).then(d=>{
    const container = $('serviceDots');
    if (!d.services) { container.innerHTML = ''; return; }
    container.innerHTML = Object.entries(d.services).map(([name, status]) => {
      const icon = SERVICE_ICONS[name] || 'fa-circle';
      const label = SERVICE_LABELS[name] || name;
      const cls = status === 'active' ? 'on' : 'off';
      return '<span class="service-indicator ' + cls + '"><i class="fas ' + icon + '"></i> ' + label + '</span>';
    }).join('');
  }).catch(e => apiError('/api/services', e, 0));
}

// -- System -- //
function loadSystem(){
  authFetch('/api/system').then(r=>r.json()).then(d=>{
    if(d.error){ $('s-uptime').textContent='error'; return }
    $('s-uptime').textContent = d.uptime || '?';
    const cpuVal = parseFloat(d.cpu);
    $('s-cpu').textContent = d.cpu;
    $('s-cpu').className = 's-val' + (cpuVal > 80 ? ' warn' : cpuVal > 50 ? '' : ' ok');
    $('s-memory').textContent = d.memory.used + '/' + d.memory.total;
    $('s-disk').textContent = d.disk.free + ' free (' + d.disk.pct + ')';
  }).catch(e => apiError('/api/system', e, 0));
}

function loadLLM(){
  authFetch('/api/llm').then(r=>r.json()).then(d=>{
    const el = $('llmStatus');
    if (!d.available) {
      el.innerHTML = '<div class="llm-card"><span class="llm-dot off"></span><span class="empty">Ollama not reachable</span></div>';
      return;
    }
    el.innerHTML = d.models.map(m =>
      '<div class="llm-card"><span class="llm-dot on"></span><span class="llm-name">' + esc(m.name) + '</span><span class="llm-size">' + m.size + '</span></div>'
    ).join('') || '<div class="llm-card"><span class="llm-dot on"></span><span class="llm-name">Ollama running, no models</span></div>';
  }).catch(e => apiError('/api/llm', e, 0));
}

function loadStats(){
  authFetch('/api/stats').then(r=>r.json()).then(d=>{
    const body = $('statsBody');
    if (!d.stats || !d.stats.length) { body.innerHTML = '<tr><td colspan="6" class="empty">No data</td></tr>'; return; }
    body.innerHTML = d.stats.map(s => {
      const rate = s.count > 0 ? Math.round(s.ok / s.count * 100) : 0;
      const barWidth = Math.max(1, rate);
      return '<tr>' +
        '<td style="color:#58a6ff;font-family:monospace">' + esc(s.name) + '</td>' +
        '<td>' + s.count + '</td>' +
        '<td style="color:#3fb950">' + s.ok + '</td>' +
        '<td style="color:' + (s.fail > 0 ? '#f85149' : '#484f58') + '">' + s.fail + '</td>' +
        '<td>' + s.avgMs + 'ms</td>' +
        '<td><div class="stats-bar"><div class="stats-bar-fill ' + (rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'fail') + '" style="width:' + barWidth + '%"></div></div> ' + rate + '%</td>' +
        '</tr>';
    }).join('');
  }).catch(e => apiError('/api/stats', e, 0));
}

// -- Activity -- //
function loadLogs(){
  authFetch('/api/logs?limit=500').then(r=>r.json()).then(d=>{
    allLogs = d.entries || [];
    logPage = 0;
    renderLogs();
  }).catch(e => apiError('/api/logs', e, 0));
}

function filterLogs(){
  logPage = 0;
  renderLogs();
}

function getFilteredLogs(){
  const search = ($('logSearch').value || '').toLowerCase();
  const srcFilter = $('logSourceFilter').value;
  const statusFilter = $('logStatusFilter').value;
  return allLogs.filter(e => {
    if (srcFilter && (e.src || 'unknown') !== srcFilter) return false;
    if (statusFilter === 'ok' && !e.ok) return false;
    if (statusFilter === 'fail' && e.ok) return false;
    if (search) {
      const haystack = (e.n + ' ' + e.a + ' ' + e.s).toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function groupSessions(logs){
  if (!logs.length) return [];
  const sessions = [];
  let current = { entries: [logs[0]], src: logs[0].src || 'unknown', startTime: new Date(logs[0].t).getTime() };
  for (let i = 1; i < logs.length; i++) {
    const entry = logs[i];
    const time = new Date(entry.t).getTime();
    const src = entry.src || 'unknown';
    const gap = current.entries[current.entries.length - 1] ? time - new Date(current.entries[current.entries.length - 1].t).getTime() : 0;
    if (gap <= SESSION_GAP_MS && src === current.src) {
      current.entries.push(entry);
    } else {
      sessions.push(current);
      current = { entries: [entry], src: src, startTime: time };
    }
  }
  sessions.push(current);
  return sessions;
}

function renderLogs(){
  const filtered = getFilteredLogs();
  $('logCount').textContent = filtered.length;
  const container = $('logList');
  if (!filtered.length) { 
    container.innerHTML = '<div class="empty">No matching activity</div>'; 
    return; 
  }

  const sessions = groupSessions(filtered);
  const visibleSessions = sessions.slice(0, logPage + 1);
  let html = '';

  visibleSessions.forEach((session, si) => {
    const src = session.src;
    const icon = SOURCE_ICONS[src] || SOURCE_ICONS['unknown'];
    const color = SOURCE_COLORS[src] || SOURCE_COLORS['unknown'];
    const startTime = fmtDate(session.entries[0].t);
    const endTime = fmtDate(session.entries[session.entries.length - 1].t);
    const timeRange = startTime === endTime ? startTime : startTime + ' - ' + endTime.split(' ')[1];

    html += '<div class="session-group">';
    html += '<div class="session-header">';
    html += '<i class="fas ' + icon + '" style="color:' + color + '"></i>';
    html += '<span class="session-time">' + esc(timeRange) + '</span>';
    html += '<span class="session-count">' + session.entries.length + ' calls</span>';
    html += '<span class="session-src">' + esc(src) + '</span>';
    html += '</div>';
    html += '<div class="session-body" id="session-' + si + '">';
    
    session.entries.forEach(e => {
      const errClass = e.ok ? '' : ' error';
      const statusClass = e.ok ? 'ok' : 'fail';
      const statusText = e.ok ? 'OK' : 'FAIL';
      
      html += '<div class="log-entry' + errClass + '">';
      html += '<div class="log-header">';
      html += '<span class="log-time">' + fmtTime(e.t) + '</span>';
      html += '<span class="log-tool">' + esc(e.n) + '</span>';
      html += '<span class="log-status ' + statusClass + '">' + statusText + '</span>';
      html += '</div>';
      
      // Show arguments
      if (e.a) {
        html += '<div class="log-args">' + esc(e.a) + '</div>';
      }
      
      // Show result (expandable)
      if (e.s) {
        const resultId = 'result-' + Math.random().toString(36).substr(2, 9);
        html += '<div class="log-result" id="' + resultId + '" data-result-id="' + resultId + '">';
        html += esc(e.s);
        html += '</div>';
      }
      
      html += '</div>';
    });
    
    html += '</div></div>';
  });

  if (visibleSessions.length < sessions.length) {
    html += '<button class="load-more" onclick="loadMoreLogs()">Show more sessions (' + (sessions.length - visibleSessions.length) + ' remaining)</button>';
  }

  container.innerHTML = html;

  container.querySelectorAll('.log-result[data-result-id]').forEach(el => {
    el.addEventListener('click', function() {
      this.classList.toggle('expanded');
    });
  });

  container.querySelectorAll('.session-header').forEach((el, idx) => {
    el.addEventListener('click', function() {
      const body = this.nextElementSibling;
      if (body) body.classList.toggle('open');
    });
  });
}

function toggleResult(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle('expanded');
  }
}

function loadMoreLogs(){
  logPage++;
  renderLogs();
}

// -- Data -- //
function loadKV(){
  Promise.all([
    authFetch('/api/kv').then(r=>r.json()),
    authFetch('/api/kv/projects').then(r=>r.json())
  ]).then(([kvData, projData]) => {
    allKV = kvData.entries || [];
    
    const select = $('kvProjectFilter');
    if (select) {
      const currentVal = select.value;
      const projects = projData.projects || [];
      select.innerHTML = '<option value="">All Projects</option>' +
        projects.map(p => p === null ? '<option value="null">Global</option>' : '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
      select.value = currentVal;
    }
    
    renderKV();
  }).catch(e => apiError('/api/kv', e, 0));
}

function filterKV(){
  renderKV();
}

function renderKV(){
  const search = ($('kvSearch').value || '').toLowerCase();
  const projectFilter = $('kvProjectFilter') ? $('kvProjectFilter').value : '';
  const ageFilter = $('kvAgeFilter') ? $('kvAgeFilter').value : 'all';
  
  let filtered = allKV.filter(e => {
    // Project filter
    if (projectFilter) {
      if (projectFilter === 'null' && e.project !== null) return false;
      if (projectFilter !== 'null' && e.project !== projectFilter) return false;
    }
    
    // Age filter
    if (ageFilter !== 'all') {
      const updated = new Date(e.updated);
      const now = new Date();
      const diffMs = now - updated;
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      
      if (ageFilter === 'today' && diffDays > 1) return false;
      if (ageFilter === 'week' && diffDays > 7) return false;
      if (ageFilter === 'month' && diffDays > 30) return false;
    }
    
    // Search filter
    if (!search) return true;
    return (e.key + ' ' + String(e.value)).toLowerCase().includes(search);
  });
  
  // Sort by updated date (newest first)
  filtered.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  
  $('kvCount').textContent = filtered.length;
  const list = $('kvList');
  if (!filtered.length) { 
    list.innerHTML = '<div class="empty">No matching data</div>'; 
    return; 
  }
  
  list.innerHTML = filtered.map(e => {
    const projectBadge = e.project 
      ? '<span class="kv-project">' + esc(e.project) + '</span>' 
      : '<span class="kv-project">global</span>';
    
    const sourceBadge = e.source 
      ? '<span class="kv-source ' + esc(e.source) + '">' + esc(e.source) + '</span>' 
      : '';
    
    const createdAgo = formatTimeAgo(e.created);
    const updatedAgo = formatTimeAgo(e.updated);
    const isUpdated = e.created !== e.updated;
    
    const valuePreview = String(e.value).substring(0, 300);
    const hasMore = String(e.value).length > 300;
    
    return '<div class="kv-entry" data-key="' + esc(e.key).replace(/"/g, '&quot;') + '">' +
      '<div class="kv-header">' +
        '<span class="kv-key">' + esc(e.key) + '</span>' +
        '<div class="kv-badges">' +
          projectBadge +
          sourceBadge +
        '</div>' +
      '</div>' +
      '<div class="kv-timestamps">' +
        '<span><i class="fas fa-plus-circle"></i> Created ' + createdAgo + '</span>' +
        (isUpdated ? '<span><i class="fas fa-edit"></i> Updated ' + updatedAgo + '</span>' : '') +
      '</div>' +
      '<div class="kv-value-preview" data-action="view">' +
        esc(valuePreview) + (hasMore ? '...' : '') +
      '</div>' +
      '<div class="kv-actions">' +
        '<button data-action="edit" title="Edit">' +
          '<i class="fas fa-edit"></i>' +
        '</button>' +
        '<button class="del" data-action="delete" title="Delete">' +
          '<i class="fas fa-trash"></i>' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');

  list.querySelectorAll('.kv-entry').forEach(entry => {
    const key = entry.dataset.key;
    entry.querySelector('[data-action="view"]').addEventListener('click', () => showValueModal(key));
    entry.querySelector('[data-action="edit"]').addEventListener('click', () => openEditModal(key));
    entry.querySelector('[data-action="delete"]').addEventListener('click', () => deleteKV(key));
  });
}

function formatTimeAgo(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return diffMins + 'm ago';
  if (diffHours < 24) return diffHours + 'h ago';
  if (diffDays < 7) return diffDays + 'd ago';
  if (diffDays < 30) return Math.floor(diffDays / 7) + 'w ago';
  if (diffDays < 365) return Math.floor(diffDays / 30) + 'mo ago';
  return Math.floor(diffDays / 365) + 'y ago';
}

function showValueModal(key) {
  const entry = allKV.find(e => e.key === key);
  if (!entry) return;
  
  const modal = document.createElement('div');
  modal.className = 'kv-modal';
  modal.onclick = function(e) {
    if (e.target === modal) modal.remove();
  };
  
  modal.innerHTML = '<div class="kv-modal-content">' +
    '<div class="kv-modal-header">' +
      '<h3>' + esc(key) + '</h3>' +
      '<button class="kv-modal-close" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:20px;">' +
        '<i class="fas fa-times"></i>' +
      '</button>' +
    '</div>' +
    '<div class="kv-modal-value">' + esc(String(entry.value)) + '</div>' +
  '</div>';
  
  modal.querySelector('.kv-modal-close').addEventListener('click', () => modal.remove());
  document.body.appendChild(modal);
}

function openEditModal(key){
  const entry = allKV.find(e => e.key === key);
  if (!entry) return;
  $('editKey').textContent = key;
  $('editValue').value = String(entry.value);
  $('editProject').value = entry.project || '';
  $('editModal').classList.add('active');
  $('editModal').dataset.key = key;
}

function closeEditModal(){
  $('editModal').classList.remove('active');
}

function saveKVEdit(){
  const key = $('editModal').dataset.key;
  const value = $('editValue').value;
  const project = $('editProject').value || null;
  authFetch('/api/kv/' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, project })
  }).then(r => r.json()).then(d => {
    if (d.ok) { closeEditModal(); loadKV(); showToast('Entry updated successfully', 'success'); }
  }).catch(e => apiError('/api/kv/' + encodeURIComponent(key), e, 0));
}

function deleteKV(key){
  if (!confirm('Delete "' + key + '"?')) return;
  authFetch('/api/kv/' + encodeURIComponent(key), { 
    method: 'DELETE'
  })
    .then(r => r.json()).then(d => { 
      if (d.ok) { 
        loadKV(); 
        showToast('Entry deleted successfully', 'success'); 
      } 
    }).catch(e => apiError('/api/kv/' + encodeURIComponent(key), e, 0));
}

// -- Config -- //
function loadConfig(){
  authFetch('/api/config').then(r=>r.json()).then(d=>{
    const list = $('configList');
    if (!d.config || !Object.keys(d.config).length){ list.innerHTML='<div class="empty">No configuration</div>'; return }
    list.innerHTML = Object.entries(d.config).map(([key, value]) => {
      const isRedacted = value === '***redacted***';
      return '<div class="config-entry"><span class="config-key">' + esc(key) + '</span><span class="config-val' + (isRedacted ? ' redacted' : '') + '">' + esc(String(value)) + '</span></div>';
    }).join('');
  }).catch(e => apiError('/api/config', e, 0));
}

// -- Agent -- //
function runAgent(){
  const goal = $('agentGoal').value.trim();
  if (!goal || agentRunning) return;
  agentRunning = true;
  $('agentGo').disabled = true;
  $('agentStop').disabled = false;
  $('agentLog').innerHTML = '<span class="agent-step">► Starting agent...</span>\\n';

  authFetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal })
  }).then(r=>r.json()).then(data => {
    if (data.error) {
      appendLog('<span class="agent-err">✖ Error: ' + esc(data.error) + '</span>');
      stopAgent();
      return;
    }
    const taskId = data.taskId;
    appendLog('<span class="agent-step">► Task ' + taskId + ' started</span>');
    agentStream = new EventSource('/api/agent/stream/' + taskId);
    agentStream.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'step') appendLog('<span class="agent-step">● ' + esc(msg.text) + '</span>');
      else if (msg.type === 'tool') appendLog('  <span class="agent-ok">→ ' + esc(msg.tool) + '</span> ' + esc(msg.summary));
      else if (msg.type === 'error') appendLog('<span class="agent-err">✖ ' + esc(msg.text) + '</span>');
      else if (msg.type === 'done') {
        appendLog('<span class="agent-done">✔ ' + esc(msg.text) + '</span>');
        stopAgent();
      }
    };
    agentStream.onerror = () => stopAgent();
  }).catch(e => {
    appendLog('<span class="agent-err"> Request failed: ' + esc(e.message) + '</span>');
    apiError('/api/agent/run', e, 0);
    stopAgent();
  });
}

function appendLog(html){
  $('agentLog').innerHTML += html + '\\n';
  $('agentLog').scrollTop = $('agentLog').scrollHeight;
}

function stopAgent(){
  if (agentStream) { agentStream.close(); agentStream = null; }
  agentRunning = false;
  $('agentGo').disabled = false;
  $('agentStop').disabled = true;
}

function toggleHistory(){
  const el = $('agentHistory');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  if (el.style.display === 'block') {
      authFetch('/api/agent/history').then(r=>r.json()).then(d=>{
      let html = '<div style="color:#8b949e;font-size:.78rem;margin-bottom:12px;padding:8px;background:#161b22;border-radius:6px">' +
        '<i class="fas fa-info-circle"></i> Agent history shows tasks submitted via this dashboard. ' +
        'Tool calls from opencode appear in the Activity tab, grouped by session.</div>';
      if (!d.runs || !d.runs.length) { html += '<div class="empty">No past runs</div>'; el.innerHTML = html; return; }
      html += d.runs.map(r =>
        '<div class="history-item">' +
        '<span class="log-time">' + fmtTime(r.t) + '</span> ' +
        '<span class="' + (r.status === 'completed' ? 'log-ok' : 'log-fail') + '">' + r.status + '</span> ' +
        '<span class="log-summary" style="flex:1">' + esc(r.goal.substring(0,80)) + '</span>' +
        '<button class="btn btn-sm btn-outline" data-action="export" data-id="' + esc(r.id) + '" title="Export"><i class="fas fa-download"></i></button>' +
        '<button class="btn btn-sm btn-outline" data-action="toggle" data-id="' + esc(r.id) + '" title="Details"><i class="fas fa-chevron-down"></i></button>' +
        '<div id="run-detail-' + esc(r.id) + '" style="display:none;width:100%"></div>' +
        '</div>'
      ).join('');
      el.innerHTML = html;

      el.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          const action = this.dataset.action;
          const id = this.dataset.id;
          if (action === 'export') exportRun(id);
          else if (action === 'toggle') toggleRunDetail(id);
        });
      });
    }).catch(e => apiError('/api/agent/history', e, 0));
  }
}

function toggleRunDetail(id){
  const detail = $('run-detail-' + id);
  if (expandedHistory[id]) {
    detail.style.display = 'none';
    expandedHistory[id] = false;
    return;
  }
  expandedHistory[id] = true;
  detail.style.display = 'block';
  detail.innerHTML = '<div class="empty">Loading...</div>';
  authFetch('/api/agent/run/' + id).then(r=>r.json()).then(run=>{
    if (!run || !run.steps) { detail.innerHTML = '<div class="empty">No details</div>'; return; }
    let html = '';
    run.steps.forEach(s => {
      if (s.type === 'thought') html += '<span class="agent-step">● ' + esc(s.text) + '</span>\\n';
      else if (s.type === 'tool') html += '  <span class="agent-ok">→ ' + esc(s.tool) + '</span> ' + esc(s.args ? JSON.stringify(s.args) : '') + '\\n    ' + esc((s.result || '').substring(0, 200)) + '\\n';
      else if (s.type === 'error') html += '<span class="agent-err">✖ ' + esc(s.text) + '</span>\\n';
      else if (s.type === 'done') html += '<span class="agent-done">✔ ' + esc(s.text) + '</span>\\n';
    });
    detail.innerHTML = '<div class="history-detail">' + html + '</div>';
  }).catch(e => { 
    detail.innerHTML = '<div class="agent-err">Failed to load details</div>'; 
    apiError('/api/agent/run/' + id, e, 0);
  });
}

function exportRun(id){
  authFetch('/api/agent/run/' + id).then(r=>r.json()).then(run=>{
    const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agent-run-' + id + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }).catch(e => apiError('/api/agent/run/' + id, e, 0));
}

function clearData(type){
  const messages = {
    logs: 'Clear all activity logs? This cannot be undone.',
    kv: 'Clear all stored KV data? This cannot be undone.',
    conversations: 'Clear all agent conversation history? This cannot be undone.',
    all: 'Clear ALL data (logs, KV, conversations)? This cannot be undone.'
  };
  if (!confirm(messages[type])) return;
  const endpoints = {
    logs: '/api/logs',
    kv: '/api/kv',
    conversations: '/api/conversations',
    all: '/api/data'
  };
  authFetch(endpoints[type], { 
    method: 'DELETE'
  })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        if (type === 'logs' || type === 'all') loadLogs();
        if (type === 'kv' || type === 'all') loadKV();
        showToast('Data cleared successfully', 'success');
      }
    })
    .catch(e => apiError(endpoints[type], e, 0));
}

// -- Tools -- //
let toolStats = {};

function loadTools(){
  Promise.all([
    authFetch('/api/tools').then(r=>r.json()),
    authFetch('/api/stats').then(r=>r.json())
  ]).then(([toolsData, statsData]) => {
    allTools = toolsData.tools || [];
    toolStats = {};
    (statsData.stats || []).forEach(s => {
      toolStats[s.name] = s;
    });
    renderTools();
  }).catch(e => apiError('/api/tools', e, 0));
}

function filterTools(){
  renderTools();
}

function renderTools(){
  const search = ($('toolSearch').value || '').toLowerCase();
  const catFilter = $('toolCategoryFilter').value;
  let filtered = allTools;
  if (catFilter) filtered = filtered.filter(t => getToolCategory(t.name) === catFilter);
  if (search) filtered = filtered.filter(t => (t.name + ' ' + t.description).toLowerCase().includes(search));
  $('toolCount').textContent = filtered.length;
  const container = $('toolList');
  if (!filtered.length) { container.innerHTML = '<div class="empty">No matching tools</div>'; return; }
  const grouped = {};
  for (const t of filtered) {
    const cat = getToolCategory(t.name);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(t);
  }
  let html = '';
  for (const [cat, tools] of Object.entries(grouped).sort((a,b) => a[0].localeCompare(b[0]))) {
    const catInfo = TOOL_CATEGORIES[cat] || { icon: 'fa-wrench' };
    html += '<div class="tool-category-header">';
    html += '<i class="fas ' + catInfo.icon + '"></i>';
    html += '<span class="cat-name">' + esc(cat) + '</span>';
    html += '<span class="cat-count">' + tools.length + '</span>';
    html += '</div>';
    html += '<div class="tool-grid">';
    for (const t of tools) {
      const stats = toolStats[t.name];
      const hasStats = stats && stats.count > 0;
      html += '<div class="tool-card" onclick="showToolDetail(\\'' + esc(t.name) + '\\')">';
      html += '<div class="tool-card-name">' + esc(t.name) + '</div>';
      html += '<div class="tool-card-desc">' + esc(t.description) + '</div>';
      if (hasStats) {
        const rate = Math.round(stats.ok / stats.count * 100);
        const rateColor = rate >= 90 ? '#3fb950' : rate >= 70 ? '#d29922' : '#f85149';
        html += '<div class="tool-card-stats">';
        html += '<span class="stat-item"><i class="fas fa-play"></i> ' + stats.count + '</span>';
        html += '<span class="stat-item"><i class="fas fa-check"></i> ' + stats.ok + '</span>';
        html += '<span class="stat-item"><i class="fas fa-times"></i> ' + stats.fail + '</span>';
        html += '<span class="stat-item"><i class="fas fa-clock"></i> ' + stats.avgMs + 'ms</span>';
        html += '<span class="stat-item" style="color:' + rateColor + '"><i class="fas fa-chart-line"></i> ' + rate + '%</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  container.innerHTML = html;
}

function showToolDetail(name){
  const t = allTools.find(x => x.name === name);
  if (!t) return;
  const cat = getToolCategory(name);
  const catInfo = TOOL_CATEGORIES[cat] || { icon: 'fa-wrench' };
  const stats = toolStats[name];
  const hasStats = stats && stats.count > 0;
  let html = '<div class="tool-detail-overlay active" onclick="if(event.target===this)this.classList.remove(\\'active\\')">';
  html += '<div class="tool-detail">';
  html += '<h3><i class="fas ' + catInfo.icon + '" style="margin-right:8px"></i>' + esc(t.name) + '</h3>';
  html += '<div class="td-desc">' + esc(t.description) + '</div>';
  html += '<div class="td-section"><div class="td-label">Category</div><div style="color:#58a6ff">' + esc(cat) + '</div></div>';
  if (hasStats) {
    const rate = Math.round(stats.ok / stats.count * 100);
    const rateColor = rate >= 90 ? '#3fb950' : rate >= 70 ? '#d29922' : '#f85149';
    html += '<div class="td-section"><div class="td-label">Usage Stats</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;text-align:center">';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:#58a6ff">' + stats.count + '</div><div style="font-size:.7rem;color:#8b949e">CALLS</div></div>';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:#3fb950">' + stats.ok + '</div><div style="font-size:.7rem;color:#8b949e">SUCCESS</div></div>';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:#f85149">' + stats.fail + '</div><div style="font-size:.7rem;color:#8b949e">FAIL</div></div>';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:#c9d1d9">' + stats.avgMs + 'ms</div><div style="font-size:.7rem;color:#8b949e">AVG</div></div>';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:' + rateColor + '">' + rate + '%</div><div style="font-size:.7rem;color:#8b949e">RATE</div></div>';
    html += '</div></div>';
  }
  if (t.args && Object.keys(t.args).length) {
    html += '<div class="td-section"><div class="td-label">Arguments</div><div class="td-args">';
    for (const [k, v] of Object.entries(t.args)) {
      const isOpt = String(v).includes('optional');
      html += '<div class="td-arg-row"><span class="td-arg-name">' + esc(k) + '</span><span class="td-arg-type">' + esc(String(v)) + '</span>' + (isOpt ? ' <span style="color:#484f58;font-size:.75rem">(optional)</span>' : '') + '</div>';
    }
    html += '</div></div>';
  }
  html += '<div style="margin-top:16px;text-align:right"><button class="btn btn-outline" onclick="this.closest(\\'.tool-detail-overlay\\').classList.remove(\\'active\\')">Close</button></div>';
  html += '</div></div>';
  const existing = document.querySelector('.tool-detail-overlay');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

// -- Refresh -- //
function refresh(){
  // Only refresh if on system page AND tab is visible
  if (currentPage !== 'system') return;
  if (document.hidden) return;
  
  const now = new Date();
  $('lastUpdate').textContent = 'updated ' + now.toLocaleTimeString();
  loadSystem(); loadLLM(); loadServices(); loadStats();
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  seedKV();
  console.log("Sidekick dashboard listening on http://0.0.0.0:" + PORT);
});
