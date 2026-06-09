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
    "security:last_login": exec("last -1 -F -n 1 2>/dev/null | head -1 | awk '{print \$1,\$3,\$4,\$5}'"),
    "security:failed_logins": exec("grep -c 'Failed password' /var/log/auth.log 2>/dev/null || echo 0"),

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

// --- Frontend ---

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sidekick Dashboard</title>
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
footer{text-align:center;font-size:.75rem;color:#484f58;padding:24px 0}
</style>
</head>
<body>
<div class="header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:12px;border-bottom:1px solid #21262d">
  <div>
    <h1 style="font-size:1.4rem;color:#58a6ff">Sidekick Dashboard</h1>
    <div class="sub">64.176.216.202</div>
  </div>
  <div class="sub" id="lastUpdate"></div>
</div>

<nav>
  <a class="active" onclick="showPage('system')" id="nav-system">System</a>
  <a onclick="showPage('activity')" id="nav-activity">Activity</a>
  <a onclick="showPage('data')" id="nav-data">Data</a>
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

function $(id){return document.getElementById(id)}

function showPage(name){
  currentPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  $('page-' + name).classList.add('active');
  $('nav-' + name).classList.add('active');
  if (name === 'system') { loadSystem(); loadLLM(); }
  if (name === 'activity') loadLogs();
  if (name === 'data') loadKV();
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
    list.innerHTML = d.entries.map(e =>
      '<div class="log-entry">' +
      '<span class="log-time">' + fmtTime(e.t) + '</span>' +
      '<span class="log-name">' + esc(e.n) + '</span>' +
      '<span class="' + (e.ok ? 'log-ok' : 'log-fail') + '">' + (e.ok ? 'OK' : 'FAIL') + '</span>' +
      '<span class="log-summary">' + esc(e.s) + '</span></div>'
    ).join('');
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
    appendLog('<span class="agent-err">✖ Request failed: ' + esc(e.message) + '</span>');
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
        '<div class="log-entry" style="cursor:pointer" onclick="loadRun(\\'' + r.id + '\\')">' +
        '<span class="log-time">' + fmtTime(r.t) + '</span>' +
        '<span class="' + (r.status === 'completed' ? 'log-ok' : 'log-fail') + '">' + r.status + '</span>' +
        '<span class="log-summary">' + esc(r.goal.substring(0,80)) + '</span></div>'
      ).join('');
    }).catch(()=>{});
  }
}

function loadRun(id){
  fetch('/api/agent/run/' + id).then(r=>r.json()).then(run=>{
    if (!run) return;
    $('agentLog').innerHTML = '<span class="agent-step">► Run: ' + esc(run.goal) + '</span>\\n';
    (run.steps || []).forEach(s => {
      if (s.type === 'thought') appendLog('<span class="agent-step">● ' + esc(s.text) + '</span>');
      else if (s.type === 'tool') appendLog('  <span class="agent-ok">→ ' + esc(s.tool) + '</span> ' + esc(s.result || ''));
      else if (s.type === 'error') appendLog('<span class="agent-err">✖ ' + esc(s.text) + '</span>');
    });
    if (run.status === 'completed') appendLog('<span class="agent-done">✔ Completed</span>');
    else appendLog('<span class="agent-err">✖ ' + run.status + '</span>');
  }).catch(()=>{});
}

// -- Refresh -- //
function refresh(){
  const now = new Date();
  $('lastUpdate').textContent = 'updated ' + now.toLocaleTimeString();
  if (currentPage === 'system') { loadSystem(); loadLLM(); }
  else if (currentPage === 'activity') loadLogs();
  else if (currentPage === 'data') loadKV();
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
