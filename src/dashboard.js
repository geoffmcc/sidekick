const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const PORT = parseInt(process.env.SIDEKICK_DASHBOARD_PORT || "4098", 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const http = require("http");
const AGENT_PORT = parseInt(process.env.SIDEKICK_AGENT_PORT || "4099", 10);

const DASHBOARD_USER = process.env.SIDEKICK_DASHBOARD_USER || "";
const DASHBOARD_PASS = process.env.SIDEKICK_DASHBOARD_PASS || "";

if (DASHBOARD_USER && DASHBOARD_PASS) {
  app.use((req, res, next) => {
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

app.all(/^\/api\/agent\//, (req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const opts = {
      hostname: "127.0.0.1", port: AGENT_PORT,
      path: req.originalUrl, method: req.method,
      headers: { ...req.headers, host: "127.0.0.1:" + AGENT_PORT }
    };
    if (body) opts.headers["Content-Length"] = Buffer.byteLength(body);
    const pr = http.request(opts, px => {
      res.writeHead(px.statusCode, px.headers);
      px.pipe(res);
    });
    pr.on("error", () => { if (!res.headersSent) res.status(502).json({ error: "Agent unavailable" }); });
    if (body) pr.write(body);
    pr.end();
  });
});

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
  const gitOpts = { cwd: repoRoot };
  const now = new Date().toISOString();

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

    "deploy:git_commit": exec("git rev-parse HEAD", gitOpts),
    "deploy:branch": exec("git rev-parse --abbrev-ref HEAD", gitOpts),
    "deploy:remote_url": exec("git remote get-url origin", gitOpts),
    "deploy:initialized": now,

    "config:timezone": exec("timedatectl show -p Timezone --value 2>/dev/null || echo UTC"),
    "config:locale": exec(`grep LANG= /etc/default/locale 2>/dev/null | cut -d= -f2 || echo C.UTF-8`),
    "config:env": process.env.NODE_ENV || "production",
  };

  Object.assign(kv, seed);
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
  const entries = Object.entries(kv).map(([key, value]) => ({ key, value }));
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
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const { value } = JSON.parse(body);
      const kv = readKV();
      kv[req.params.key] = value;
      writeKV(kv);
      res.json({ ok: true });
    } catch { res.status(400).json({ error: "invalid body" }); }
  });
});

app.delete("/api/kv/:key", (req, res) => {
  const kv = readKV();
  delete kv[req.params.key];
  writeKV(kv);
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
nav{display:flex;gap:8px;margin-bottom:20px}
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
</style>
</head>
<body>
<div class="header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:12px;border-bottom:1px solid #21262d">
  <div>
    <h1 style="font-size:1.4rem;color:#58a6ff">Sidekick Dashboard <span id="serviceDots" style="font-size:.85rem;margin-left:12px"></span></h1>
    <div class="sub">149.28.229.13</div>
  </div>
  <div class="sub" id="lastUpdate"></div>
</div>

<nav>
  <a class="active" onclick="showPage('system')" id="nav-system">System</a>
  <a onclick="showPage('activity')" id="nav-activity">Activity</a>
  <a onclick="showPage('data')" id="nav-data">Data</a>
  <a onclick="showPage('config')" id="nav-config">Config</a>
  <a onclick="showPage('agent')" id="nav-agent">Agent</a>
</nav>

<!-- System Page -->
<div class="page active" id="page-system">
  <div class="grid" id="systemCards">
    <div class="card"><div class="label">Uptime</div><div class="value" id="uptime">...</div></div>
    <div class="card"><div class="label">CPU</div><div class="value" id="cpu">...</div></div>
    <div class="card"><div class="label">Memory</div><div class="value" id="memory">...</div></div>
    <div class="card"><div class="label">Disk</div><div class="value" id="disk">...</div></div>
  </div>
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
  <div class="section-title">Activity Log (<span id="logCount">0</span>)</div>
  <div id="logList" style="max-height:600px;overflow-y:auto"></div>
</div>

<!-- Data Page -->
<div class="page" id="page-data">
  <div class="search-bar">
    <input type="text" id="kvSearch" placeholder="Search keys or values..." oninput="filterKV()">
  </div>
  <div class="section-title">Stored Data (<span id="kvCount">0</span>)</div>
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

<!-- Edit Modal -->
<div class="modal-overlay" id="editModal">
  <div class="modal">
    <h3>Edit KV Entry</h3>
    <div style="margin-bottom:8px;color:#8b949e;font-size:.82rem">Key: <span id="editKey" style="color:#ffa657;font-family:monospace"></span></div>
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

const SERVICE_ICONS = { 'sidekick-mcp': 'fa-server', 'sidekick-agent': 'fa-robot', 'ollama': 'fa-brain' };
const SERVICE_LABELS = { 'sidekick-mcp': 'MCP', 'sidekick-agent': 'Agent', 'ollama': 'Ollama' };
const SOURCE_ICONS = { 'agent': 'fa-robot', 'mcp': 'fa-plug', 'unknown': 'fa-circle-question' };
const SOURCE_COLORS = { 'agent': '#58a6ff', 'mcp': '#bc8cff', 'unknown': '#8b949e' };

function $(id){return document.getElementById(id)}

function showPage(name){
  currentPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  $('page-' + name).classList.add('active');
  $('nav-' + name).classList.add('active');
  if (name === 'system') { loadSystem(); loadLLM(); loadServices(); loadStats(); }
  if (name === 'activity') loadLogs();
  if (name === 'data') loadKV();
  if (name === 'config') loadConfig();
}

function fmtTime(iso){
  const d = new Date(iso);
  return d.toLocaleTimeString() + "." + String(d.getMilliseconds()).padStart(3,'0');
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
  fetch('/api/services').then(r=>r.json()).then(d=>{
    const container = $('serviceDots');
    if (!d.services) { container.innerHTML = ''; return; }
    container.innerHTML = Object.entries(d.services).map(([name, status]) => {
      const icon = SERVICE_ICONS[name] || 'fa-circle';
      const label = SERVICE_LABELS[name] || name;
      const cls = status === 'active' ? 'on' : 'off';
      return '<span class="service-indicator ' + cls + '"><i class="fas ' + icon + '"></i> ' + label + '</span>';
    }).join('');
  }).catch(()=>{});
}

// -- System -- //
function loadSystem(){
  fetch('/api/system').then(r=>r.json()).then(d=>{
    if(d.error){ $('uptime').textContent='error'; return }
    $('uptime').textContent = d.uptime || '?';
    const cpuVal = parseFloat(d.cpu);
    $('cpu').textContent = d.cpu;
    $('cpu').className = 'value' + (cpuVal > 80 ? ' warn' : cpuVal > 50 ? '' : ' ok');
    $('memory').textContent = d.memory.used + '/' + d.memory.total;
    $('disk').textContent = d.disk.free + ' free (' + d.disk.pct + ')';
  }).catch(()=>{});
}

function loadLLM(){
  fetch('/api/llm').then(r=>r.json()).then(d=>{
    const el = $('llmStatus');
    if (!d.available) {
      el.innerHTML = '<div class="llm-card"><span class="llm-dot off"></span><span class="empty">Ollama not reachable</span></div>';
      return;
    }
    el.innerHTML = d.models.map(m =>
      '<div class="llm-card"><span class="llm-dot on"></span><span class="llm-name">' + esc(m.name) + '</span><span class="llm-size">' + m.size + '</span></div>'
    ).join('') || '<div class="llm-card"><span class="llm-dot on"></span><span class="llm-name">Ollama running, no models</span></div>';
  }).catch(()=>{});
}

function loadStats(){
  fetch('/api/stats').then(r=>r.json()).then(d=>{
    const body = $('statsBody');
    if (!d.stats || !d.stats.length) { body.innerHTML = '<tr><td colspan="6" class="empty">No data</td></tr>'; return; }
    const maxCount = Math.max(...d.stats.map(s => s.count));
    body.innerHTML = d.stats.map(s => {
      const rate = s.count > 0 ? Math.round(s.ok / s.count * 100) : 0;
      const barWidth = Math.round(s.count / maxCount * 100);
      return '<tr>' +
        '<td style="color:#58a6ff;font-family:monospace">' + esc(s.name) + '</td>' +
        '<td>' + s.count + '</td>' +
        '<td style="color:#3fb950">' + s.ok + '</td>' +
        '<td style="color:' + (s.fail > 0 ? '#f85149' : '#484f58') + '">' + s.fail + '</td>' +
        '<td>' + s.avgMs + 'ms</td>' +
        '<td><div class="stats-bar"><div class="stats-bar-fill ' + (rate >= 90 ? 'ok' : rate >= 70 ? '' : 'fail') + '" style="width:' + barWidth + '%"></div></div> ' + rate + '%</td>' +
        '</tr>';
    }).join('');
  }).catch(()=>{});
}

// -- Activity -- //
function loadLogs(){
  fetch('/api/logs?limit=500').then(r=>r.json()).then(d=>{
    allLogs = d.entries || [];
    logPage = 0;
    renderLogs();
  }).catch(()=>{});
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
  if (!filtered.length) { container.innerHTML = '<div class="empty">No matching activity</div>'; return; }

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
    html += '<div class="session-header" onclick="toggleSession(' + si + ')">';
    html += '<i class="fas ' + icon + '" style="color:' + color + '"></i>';
    html += '<span class="session-time">' + esc(timeRange) + '</span>';
    html += '<span class="session-count">' + session.entries.length + ' calls</span>';
    html += '<span class="session-src">' + esc(src) + '</span>';
    html += '</div>';
    html += '<div class="session-body" id="session-' + si + '">';
    session.entries.forEach(e => {
      const errClass = e.ok ? '' : ' error';
      html += '<div class="log-entry' + errClass + '">';
      html += '<span class="log-time">' + fmtTime(e.t) + '</span>';
      html += '<span class="log-name">' + esc(e.n) + '</span>';
      html += '<span class="' + (e.ok ? 'log-ok' : 'log-fail') + '">' + (e.ok ? 'OK' : 'FAIL') + '</span>';
      if (e.a) html += '<span class="log-args">' + esc(e.a) + '</span>';
      else html += '<span class="log-summary">' + esc(e.s) + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
  });

  if (visibleSessions.length < sessions.length) {
    html += '<button class="load-more" onclick="loadMoreLogs()">Show more sessions (' + (sessions.length - visibleSessions.length) + ' remaining)</button>';
  }

  container.innerHTML = html;
}

function toggleSession(idx){
  const body = $('session-' + idx);
  body.classList.toggle('open');
}

function loadMoreLogs(){
  logPage++;
  renderLogs();
}

// -- Data -- //
function loadKV(){
  fetch('/api/kv').then(r=>r.json()).then(d=>{
    allKV = d.entries || [];
    renderKV();
  }).catch(()=>{});
}

function filterKV(){
  renderKV();
}

function renderKV(){
  const search = ($('kvSearch').value || '').toLowerCase();
  const filtered = allKV.filter(e => {
    if (!search) return true;
    return (e.key + ' ' + String(e.value)).toLowerCase().includes(search);
  });
  $('kvCount').textContent = filtered.length;
  const list = $('kvList');
  if (!filtered.length) { list.innerHTML = '<div class="empty">No matching data</div>'; return; }
  list.innerHTML = filtered.map(e =>
    '<div class="kv-entry">' +
    '<span class="kv-key">' + esc(e.key) + '</span>' +
    '<span class="kv-val">' + esc(String(e.value).substring(0,200)) + (String(e.value).length > 200 ? '...' : '') + '</span>' +
    '<span class="kv-actions">' +
    '<button onclick="openEditModal(\\'' + esc(e.key).replace(/'/g, "\\\\'") + '\\')"><i class="fas fa-edit"></i></button>' +
    '<button class="del" onclick="deleteKV(\\'' + esc(e.key).replace(/'/g, "\\\\'") + '\\')"><i class="fas fa-trash"></i></button>' +
    '</span></div>'
  ).join('');
}

function openEditModal(key){
  const entry = allKV.find(e => e.key === key);
  if (!entry) return;
  $('editKey').textContent = key;
  $('editValue').value = String(entry.value);
  $('editModal').classList.add('active');
  $('editModal').dataset.key = key;
}

function closeEditModal(){
  $('editModal').classList.remove('active');
}

function saveKVEdit(){
  const key = $('editModal').dataset.key;
  const value = $('editValue').value;
  fetch('/api/kv/' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value })
  }).then(r => r.json()).then(d => {
    if (d.ok) { closeEditModal(); loadKV(); }
  }).catch(()=>{});
}

function deleteKV(key){
  if (!confirm('Delete "' + key + '"?')) return;
  fetch('/api/kv/' + encodeURIComponent(key), { method: 'DELETE' })
    .then(r => r.json()).then(d => { if (d.ok) loadKV(); }).catch(()=>{});
}

// -- Config -- //
function loadConfig(){
  fetch('/api/config').then(r=>r.json()).then(d=>{
    const list = $('configList');
    if (!d.config || !Object.keys(d.config).length){ list.innerHTML='<div class="empty">No configuration</div>'; return }
    list.innerHTML = Object.entries(d.config).map(([key, value]) => {
      const isRedacted = value === '***redacted***';
      return '<div class="config-entry"><span class="config-key">' + esc(key) + '</span><span class="config-val' + (isRedacted ? ' redacted' : '') + '">' + esc(String(value)) + '</span></div>';
    }).join('');
  }).catch(()=>{});
}

// -- Agent -- //
function runAgent(){
  const goal = $('agentGoal').value.trim();
  if (!goal || agentRunning) return;
  agentRunning = true;
  $('agentGo').disabled = true;
  $('agentStop').disabled = false;
  $('agentLog').innerHTML = '<span class="agent-step">► Starting agent...</span>\\n';

  fetch('/api/agent/run', {
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
    fetch('/api/agent/history').then(r=>r.json()).then(d=>{
      if (!d.runs || !d.runs.length) { el.innerHTML = '<div class="empty">No past runs</div>'; return; }
      el.innerHTML = d.runs.map(r =>
        '<div class="history-item">' +
        '<span class="log-time">' + fmtTime(r.t) + '</span> ' +
        '<span class="' + (r.status === 'completed' ? 'log-ok' : 'log-fail') + '">' + r.status + '</span> ' +
        '<span class="log-summary" style="flex:1">' + esc(r.goal.substring(0,80)) + '</span>' +
        '<button class="btn btn-sm btn-outline" onclick="exportRun(\\'' + r.id + '\\')"><i class="fas fa-download"></i></button>' +
        '<button class="btn btn-sm btn-outline" onclick="toggleRunDetail(\\'' + r.id + '\\')"><i class="fas fa-chevron-down"></i></button>' +
        '<div id="run-detail-' + r.id + '" style="display:none;width:100%"></div>' +
        '</div>'
      ).join('');
    }).catch(()=>{});
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
  fetch('/api/agent/run/' + id).then(r=>r.json()).then(run=>{
    if (!run || !run.steps) { detail.innerHTML = '<div class="empty">No details</div>'; return; }
    let html = '';
    run.steps.forEach(s => {
      if (s.type === 'thought') html += '<span class="agent-step">● ' + esc(s.text) + '</span>\\n';
      else if (s.type === 'tool') html += '  <span class="agent-ok">→ ' + esc(s.tool) + '</span> ' + esc(s.args ? JSON.stringify(s.args) : '') + '\\n    ' + esc((s.result || '').substring(0, 200)) + '\\n';
      else if (s.type === 'error') html += '<span class="agent-err">✖ ' + esc(s.text) + '</span>\\n';
      else if (s.type === 'done') html += '<span class="agent-done">✔ ' + esc(s.text) + '</span>\\n';
    });
    detail.innerHTML = '<div class="history-detail">' + html + '</div>';
  }).catch(()=>{ detail.innerHTML = '<div class="agent-err">Failed to load details</div>'; });
}

function exportRun(id){
  fetch('/api/agent/run/' + id).then(r=>r.json()).then(run=>{
    const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agent-run-' + id + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }).catch(()=>{});
}

// -- Refresh -- //
function refresh(){
  const now = new Date();
  $('lastUpdate').textContent = 'updated ' + now.toLocaleTimeString();
  if (currentPage === 'system') { loadSystem(); loadLLM(); loadServices(); loadStats(); }
  else if (currentPage === 'activity') loadLogs();
  else if (currentPage === 'data') loadKV();
  else if (currentPage === 'config') loadConfig();
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
