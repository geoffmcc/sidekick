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
.log-time{color:#8b949e;white-space:nowrap;font-family:monospace;min-width:140px}
.log-name{color:#58a6ff;font-weight:500;min-width:130px;font-family:monospace}
.log-ok{color:#3fb950}
.log-fail{color:#f85149}
.log-summary{color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.kv-entry{padding:6px 0;border-bottom:1px solid #21262d;font-size:.82rem}
.kv-entry:last-child{border-bottom:none}
.kv-key{color:#ffa657;font-family:monospace;font-weight:500}
.kv-val{color:#c9d1d9;font-family:monospace;word-break:break-all}
.empty{color:#484f58;font-style:italic;padding:12px 0}
.agent-goal{width:100%;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:.9rem;margin-bottom:8px;resize:vertical}
.agent-goal:focus{outline:none;border-color:#58a6ff}
.btn{background:#238636;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:.85rem}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-danger{background:#da3633}
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
.history-item{padding:8px 0;border-bottom:1px solid #21262d;font-size:.82rem;cursor:pointer}
.history-item:hover{background:#161b22}
.history-item:last-child{border-bottom:none}
.history-detail{padding:8px 0 8px 20px;background:#0d1117;border-left:2px solid #21262d;margin:4px 0;font-family:monospace;font-size:.78rem;white-space:pre-wrap;line-height:1.4;max-height:400px;overflow-y:auto}
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
</div>

<!-- Activity Page -->
<div class="page" id="page-activity">
  <div class="section-title">Activity Log (<span id="logCount">0</span>)</div>
  <div class="card" id="logList" style="max-height:600px;overflow-y:auto;padding:8px 16px"></div>
</div>

<!-- Data Page -->
<div class="page" id="page-data">
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

<footer>refreshes every 10s</footer>

<script>
let currentPage = 'system';
let agentRunning = false;
let agentStream = null;
let expandedHistory = {};

const SERVICE_ICONS = {
  'sidekick-mcp': 'fa-server',
  'sidekick-agent': 'fa-robot',
  'ollama': 'fa-brain'
};

const SERVICE_LABELS = {
  'sidekick-mcp': 'MCP',
  'sidekick-agent': 'Agent',
  'ollama': 'Ollama'
};

const SOURCE_ICONS = {
  'agent': 'fa-robot',
  'mcp': 'fa-plug',
  'unknown': 'fa-circle-question'
};

const SOURCE_COLORS = {
  'agent': '#58a6ff',
  'mcp': '#bc8cff',
  'unknown': '#8b949e'
};

function $(id){return document.getElementById(id)}

function showPage(name){
  currentPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  $('page-' + name).classList.add('active');
  $('nav-' + name).classList.add('active');
  if (name === 'system') { loadSystem(); loadLLM(); loadServices(); }
  if (name === 'activity') loadLogs();
  if (name === 'data') loadKV();
  if (name === 'config') loadConfig();
}

function fmtTime(iso){
  const d = new Date(iso);
  return d.toLocaleTimeString() + "." + String(d.getMilliseconds()).padStart(3,'0');
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
    const html = Object.entries(d.services).map(([name, status]) => {
      const icon = SERVICE_ICONS[name] || 'fa-circle';
      const label = SERVICE_LABELS[name] || name;
      const cls = status === 'active' ? 'on' : 'off';
      return '<span class="service-indicator ' + cls + '"><i class="fas ' + icon + '"></i> ' + label + '</span>';
    }).join('');
    container.innerHTML = html;
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

// -- Activity -- //
function loadLogs(){
  fetch('/api/logs?limit=50').then(r=>r.json()).then(d=>{
    $('logCount').textContent = d.total;
    const list = $('logList');
    if (!d.entries.length){ list.innerHTML='<div class="empty">No activity yet</div>'; return }
    list.innerHTML = d.entries.map(e => {
      const src = e.src || 'unknown';
      const icon = SOURCE_ICONS[src] || SOURCE_ICONS['unknown'];
      const color = SOURCE_COLORS[src] || SOURCE_COLORS['unknown'];
      return '<div class="log-entry">' +
        '<span class="log-time">' + fmtTime(e.t) + '</span>' +
        '<i class="fas ' + icon + '" style="color:' + color + ';margin-right:6px;font-size:.75rem"></i>' +
        '<span class="log-name">' + esc(e.n) + '</span>' +
        '<span class="' + (e.ok ? 'log-ok' : 'log-fail') + '">' + (e.ok ? 'OK' : 'FAIL') + '</span>' +
        '<span class="log-summary">' + esc(e.s) + '</span></div>';
    }).join('');
  }).catch(()=>{});
}

// -- Data -- //
function loadKV(){
  fetch('/api/kv').then(r=>r.json()).then(d=>{
    $('kvCount').textContent = d.total;
    const list = $('kvList');
    if (!d.entries.length){ list.innerHTML='<div class="empty">No stored data</div>'; return }
    list.innerHTML = d.entries.map(e =>
      '<div class="kv-entry"><span class="kv-key">' + esc(e.key) + '</span>: <span class="kv-val">' + esc(String(e.value).substring(0,200)) + '</span></div>'
    ).join('');
  }).catch(()=>{});
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
        '<div class="history-item" onclick="toggleRunDetail(\\'' + r.id + '\\')">' +
        '<span class="log-time">' + fmtTime(r.t) + '</span> ' +
        '<span class="' + (r.status === 'completed' ? 'log-ok' : 'log-fail') + '">' + r.status + '</span> ' +
        '<span class="log-summary">' + esc(r.goal.substring(0,80)) + '</span>' +
        '<div id="run-detail-' + r.id + '" style="display:none"></div></div>'
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

// -- Refresh -- //
function refresh(){
  const now = new Date();
  $('lastUpdate').textContent = 'updated ' + now.toLocaleTimeString();
  if (currentPage === 'system') { loadSystem(); loadLLM(); loadServices(); }
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
