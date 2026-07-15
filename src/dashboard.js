require("./env");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { timingSafeCompare } = require("./crypto-utils");
const { execSync } = require("child_process");
const { TOOLS, setSource, getToolDefsForSource, getToolCategoriesWithTools, buildPolicyInspection, summarizePolicyInspection, enforceToolPolicy, listApprovals, resolveApproval } = require("./tools");
const dynamicTools = require("./dynamic-tools");
const dbStore = require("./db");
const { allowedActions } = require("./evolve/lifecycle");
const { redactSensitive } = require("./redact");
const crypto = require("crypto");
const blackbox = require("./blackbox");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const PORT = parseInt(process.env.SIDEKICK_DASHBOARD_PORT || "4098", 10);
const MCP_PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const GRAFANA_PORT = parseInt(process.env.SIDEKICK_GRAFANA_PORT || "3000", 10);
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
const GRAFANA_USER = process.env.SIDEKICK_GRAFANA_ADMIN_USER || "sidekick";
const GRAFANA_PASS = process.env.SIDEKICK_GRAFANA_ADMIN_PASSWORD || "";

// Session cookie auth
const SESSION_SECRET = process.env.SIDEKICK_SECRET_KEY || crypto.randomBytes(32).toString("hex");
const SESSION_TTL = 86400000; // 24h

function makeSessionToken(user) {
  const payload = JSON.stringify({ u: user, e: Date.now() + SESSION_TTL });
  const b64 = Buffer.from(payload).toString("base64");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("hex");
  return b64 + "." + sig;
}

function verifySessionToken(token) {
  try {
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("hex");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(b64, "base64").toString());
    if (payload.e < Date.now()) return null;
    return payload.u;
  } catch {
    return null;
  }
}

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
const RATE_LIMIT_WINDOW = parseInt(process.env.SIDEKICK_DASHBOARD_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10);
const RATE_LIMIT_MAX = parseInt(process.env.SIDEKICK_DASHBOARD_RATE_LIMIT_MAX || "1500", 10);

function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = (rateLimit.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) return false;
  timestamps.push(now);
  rateLimit.set(ip, timestamps);
  return true;
}

function shouldRateLimit(req) {
  if (req.path.startsWith('/static/')) return false;
  if (req.path.startsWith('/grafana/')) return false;
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
  if (!shouldRateLimit(req)) return next();
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many dashboard requests, please wait before refreshing', windowMs: RATE_LIMIT_WINDOW, limit: RATE_LIMIT_MAX });
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
    // Check session cookie first (browsers always send cookies with iframe sub-resources)
    const cookie = req.headers.cookie || "";
    for (const part of cookie.split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith("sidekick_sid=")) {
        const user = verifySessionToken(trimmed.slice("sidekick_sid=".length));
        if (user === DASHBOARD_USER) return next();
      }
    }
    // Fall back to Basic Auth
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Basic ")) {
      res.set("WWW-Authenticate", 'Basic realm="Sidekick Dashboard"');
      return res.status(401).send("Authentication required");
    }
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const separator = decoded.indexOf(":");
    const user = separator >= 0 ? decoded.slice(0, separator) : "";
    const pass = separator >= 0 ? decoded.slice(separator + 1) : "";
    if (timingSafeCompare(user, DASHBOARD_USER) && timingSafeCompare(pass, DASHBOARD_PASS)) {
      // Set session cookie for subsequent requests (including iframe sub-resources)
      res.setHeader("Set-Cookie", `sidekick_sid=${makeSessionToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
      return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Sidekick Dashboard"');
    res.status(401).send("Authentication required");
  });
}

// Grafana auth proxy doesn't create a real session token,
// so token rotation always 401s. Return a mock success to
// prevent the SPA from retrying in an infinite loop.
app.post('/grafana/api/user/auth-tokens/rotate', (req, res) => {
  res.json({});
});

app.use('/grafana', (req, res) => {
  if (!GRAFANA_USER) return res.status(503).send('Grafana proxy is not configured');
  const targetPath = req.originalUrl || '/grafana/';
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.cookie;
  delete headers.authorization;
  // Grafana Auth Proxy: set trusted user header (strip any incoming to prevent spoofing)
  delete headers['x-webauth-user'];
  headers['x-webauth-user'] = GRAFANA_USER;

  let body = null;
  if (req.body && Object.keys(req.body).length) {
    body = JSON.stringify(req.body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: GRAFANA_PORT,
    path: targetPath,
    method: req.method,
    headers,
    timeout: 10000
  }, proxyRes => {
    res.status(proxyRes.statusCode || 502);
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if (lower === 'transfer-encoding' || lower === 'content-length') continue;
      if (lower === 'location') {
        let location = String(value);
        location = location.replace(/^https?:\/\/[^/]+\/grafana\//, '/grafana/');
        location = location.replace(/^https?:\/\/[^/]+\//, '/grafana/');
        if (location.startsWith('/') && !location.startsWith('/grafana/')) location = '/grafana' + location;
        res.setHeader(key, location);
        continue;
      }
      if (lower === 'set-cookie') continue;
      res.setHeader(key, value);
    }
    proxyRes.pipe(res);
  });
  proxyReq.on('timeout', () => proxyReq.destroy(new Error('Grafana proxy timed out')));
  proxyReq.on('error', error => {
    logError(req.originalUrl, 502, error, 'grafana', req.headers['user-agent']);
    if (!res.headersSent) res.status(502).send('Grafana proxy error');
  });
  if (body) proxyReq.write(body);
  else req.pipe(proxyReq);
  if (body) proxyReq.end();
});

// --- API ---

function readLogs() {
  return dbStore.readToolLogs();
}

function readKV() {
  return dbStore.loadKV({});
}

function blackboxJson(res, fn) {
  try {
    res.json(fn());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

function writeKV(data) {
  dbStore.replaceKV(data || {});
}

const ACTIVITY_FALLBACK_GAP_MS = 5 * 60 * 1000;

function safeString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return redactSensitive(value);
  try {
    return redactSensitive(JSON.stringify(value, null, 2));
  } catch {
    return redactSensitive(String(value));
  }
}

function summarizeValue(value, max = 220) {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function valueSize(value) {
  return Buffer.byteLength(safeString(value), "utf8");
}

function inferNamespace(key) {
  const text = String(key || "");
  const match = text.match(/^([a-z][a-z0-9_-]{1,40})[:/_-]/i);
  return match ? match[1].toLowerCase() : "global";
}

function normalizeLogEntry(entry, index = 0) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const timestamp = raw.t || raw.timestamp || null;
  const tool = raw.n || raw.tool || raw.tool_name || "unknown";
  const args = raw.args !== undefined ? raw.args : (raw.arguments !== undefined ? raw.arguments : raw.a || "");
  const result = raw.result !== undefined ? raw.result : raw.output !== undefined ? raw.output : raw.s || "";
  const error = raw.error || raw.err || (!raw.ok && raw.s ? raw.s : "");
  const source = raw.src || raw.source || "unknown";
  const project = raw.project || raw.p || null;
  const sessionId = raw.session_id || raw.sessionId || raw.sid || null;
  const taskId = raw.task_id || raw.taskId || raw.tid || null;
  const executionId = raw.execution_id || raw.executionId || ((raw.correlation_id && String(raw.generated_procedure || "").startsWith("sidekick_generated_")) ? raw.correlation_id : null);
  const duration = Number.isFinite(raw.d) ? Math.round(raw.d) : Number.isFinite(raw.duration_ms) ? Math.round(raw.duration_ms) : null;
  const success = raw.ok === undefined ? raw.success !== false : !!raw.ok;
  return {
    id: raw.id || `${timestamp || "log"}-${tool}-${index}`,
    timestamp,
    tool,
    status: success ? "success" : "failure",
    ok: success,
    duration_ms: duration,
    args: safeString(args),
    result: safeString(result),
    error: safeString(error),
    source,
    agent: raw.agent || null,
    client: raw.client || null,
    project,
    session_id: sessionId,
    task_id: taskId,
    execution_id: executionId,
    generated_procedure: raw.generated_procedure || raw.generatedProcedure || null,
    generated_activity: Boolean(raw.generated_procedure || raw.generatedProcedure || String(tool).startsWith("sidekick_generated_")),
    step_number: raw.step_number || raw.stepNumber || null,
    resource: raw.resource || raw.file || raw.path || raw.command || null,
    summary: summarizeValue(raw.s || result || error || tool, 260)
  };
}

function sessionKeyForLog(log, previous) {
  if (log.execution_id) return { key: `execution:${log.execution_id}`, method: "generated_execution" };
  if (log.session_id) return { key: `session:${log.session_id}`, method: "session_id" };
  if (log.task_id) return { key: `task:${log.task_id}`, method: "task_id" };
  const time = new Date(log.timestamp || 0).getTime();
  const previousTime = previous ? new Date(previous.timestamp || 0).getTime() : NaN;
  const sameFallback = previous && !previous.session_id && !previous.task_id && previous.source === log.source && Number.isFinite(time) && Number.isFinite(previousTime) && Math.abs(time - previousTime) <= ACTIVITY_FALLBACK_GAP_MS;
  if (sameFallback) return { key: previous._sessionKey, method: "time_source_fallback" };
  return { key: `fallback:${log.source}:${log.timestamp || time}`, method: "time_source_fallback" };
}

function buildActivitySessions(rawLogs) {
  const normalized = rawLogs.map(normalizeLogEntry).sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  const sessions = [];
  const byKey = new Map();
  let previous = null;

  for (const log of normalized) {
    const sessionInfo = sessionKeyForLog(log, previous);
    log._sessionKey = sessionInfo.key;
    let session = byKey.get(sessionInfo.key);
    if (!session) {
      session = {
        id: sessionInfo.key,
        grouping: sessionInfo.method,
        source: log.source,
        agent: log.agent || log.client || null,
        project: log.project,
        task_id: log.task_id,
        session_id: log.session_id,
        execution_id: log.execution_id,
        start_time: log.timestamp,
        end_time: log.timestamp,
        entries: []
      };
      byKey.set(sessionInfo.key, session);
      sessions.push(session);
    }
    session.entries.push(log);
    session.end_time = log.timestamp || session.end_time;
    if (!session.project && log.project) session.project = log.project;
    previous = log;
  }

  for (const session of sessions) {
    const entries = session.entries;
    const tools = [...new Set(entries.map(e => e.tool).filter(Boolean))];
    const failures = entries.filter(e => !e.ok).length;
    const durations = entries.map(e => e.duration_ms).filter(Number.isFinite);
    const startMs = new Date(session.start_time || 0).getTime();
    const endMs = new Date(session.end_time || 0).getTime();
    const summarySource = entries.find(e => e.summary && e.summary !== e.tool);
    session.duration_ms = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
    session.call_count = entries.length;
    session.success_count = entries.length - failures;
    session.failure_count = failures;
    session.warning_count = entries.filter(e => /warn|warning/i.test(e.summary || "")).length;
    session.tools = tools;
    session.status = failures ? "failure" : "success";
    session.avg_duration_ms = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
    session.summary = summarySource ? summarySource.summary : `${entries.length} ${entries.length === 1 ? "tool call" : "tool calls"}${tools.length ? ` using ${tools.slice(0, 4).join(", ")}` : ""}`;
  }

  return sessions.sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0));
}

function summarizeActivity(sessions, calls) {
  const total = calls.length;
  const successes = calls.filter(call => call.ok).length;
  const failures = total - successes;
  const durations = calls.map(call => call.duration_ms).filter(Number.isFinite).sort((a, b) => a - b);
  const toolCounts = new Map();
  for (const call of calls) toolCounts.set(call.tool, (toolCounts.get(call.tool) || 0) + 1);
  const mostUsedTools = [...toolCounts.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count).slice(0, 6);
  const longestCalls = [...calls].filter(call => Number.isFinite(call.duration_ms)).sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5);
  return {
    sessions: sessions.length,
    total_calls: total,
    success_rate: total ? Math.round((successes / total) * 100) : 0,
    failures,
    avg_duration_ms: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    median_duration_ms: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    most_used_tools: mostUsedTools,
    longest_calls: longestCalls
  };
}

function shapeKvEntry(key, entry) {
  const isEnvelope = entry && typeof entry === "object" && !Array.isArray(entry) && Object.prototype.hasOwnProperty.call(entry, "value");
  const value = isEnvelope ? entry.value : entry;
  return {
    key,
    value,
    value_text: safeString(value),
    preview: summarizeValue(value, 180),
    project: isEnvelope ? entry.project || null : null,
    source: isEnvelope ? entry.source || null : null,
    category: isEnvelope ? entry.category || null : null,
    namespace: inferNamespace(key),
    size: valueSize(value),
    data_type: valueType(value),
    created: isEnvelope ? entry.created || null : null,
    updated: isEnvelope ? entry.updated || null : null
  };
}

function memoryCategory(memory) {
  if (memory.type === "tool_call" || memory.source_tool && memory.type === "observation" && memory.source_tool !== "sidekick_agent") return "operational";
  if (memory.type === "session" || memory.type === "agent_task") return "sessions";
  if (memory.type === "open_thread" || memory.state === "pending") return "unresolved";
  return "durable";
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
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  let entries = readLogs().slice(0, limit).map(normalizeLogEntry);
  if (req.query.source) entries = entries.filter(entry => entry.source === req.query.source);
  if (req.query.status === "success") entries = entries.filter(entry => entry.ok);
  if (req.query.status === "failure") entries = entries.filter(entry => !entry.ok);
  if (req.query.tool) entries = entries.filter(entry => entry.tool === req.query.tool);
  if (req.query.project) entries = entries.filter(entry => entry.project === req.query.project);
  if (req.query.session) entries = entries.filter(entry => entry.session_id === req.query.session || entry.task_id === req.query.session || entry.execution_id === req.query.session || String(entry.id).includes(req.query.session));
  if (req.query.task) entries = entries.filter(entry => entry.task_id === req.query.task);
  if (req.query.execution) entries = entries.filter(entry => entry.execution_id === req.query.execution);
  if (req.query.min_duration) {
    const minDuration = Number(req.query.min_duration);
    if (Number.isFinite(minDuration)) entries = entries.filter(entry => Number(entry.duration_ms || 0) >= minDuration);
  }
  if (req.query.errors_only === "true") entries = entries.filter(entry => !entry.ok || entry.error);
  if (req.query.search) {
    const needle = String(req.query.search).toLowerCase();
    entries = entries.filter(entry => [entry.tool, entry.args, entry.result, entry.error, entry.summary, entry.source, entry.project, entry.session_id, entry.task_id].join(" ").toLowerCase().includes(needle));
  }
  const sessions = buildActivitySessions(entries);
  res.json({ entries, sessions, summary: summarizeActivity(sessions, entries), total: entries.length, fallback_grouping_ms: ACTIVITY_FALLBACK_GAP_MS });
});

app.get("/api/kv", (req, res) => {
  const kv = readKV();
  const entries = Object.entries(kv).map(([key, entry]) => shapeKvEntry(key, entry));
  const namespaces = [...new Set(entries.map(entry => entry.namespace))].sort();
  const projects = [...new Set(entries.map(entry => entry.project).filter(Boolean))].sort();
  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recentlyChanged = entries.filter(entry => entry.updated && new Date(entry.updated).getTime() >= recentCutoff).length;
  res.json({
    entries,
    total: entries.length,
    summary: {
      total_entries: entries.length,
      projects: projects.length,
      total_size: totalSize,
      recently_changed: recentlyChanged,
      namespaces: namespaces.length,
      largest_entries: [...entries].sort((a, b) => b.size - a.size).slice(0, 5).map(entry => ({ key: entry.key, size: entry.size }))
    },
    namespaces,
    projects
  });
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

app.get("/api/metrics/status", (req, res) => {
  const grafanaConfigured = Boolean(GRAFANA_USER);
  const influxToken = process.env.SIDEKICK_INFLUX_TOKEN || "";
  const influxConfigured = Boolean(influxToken && influxToken !== "sidekick-influx-token");
  const status = {
    grafana: {
      configured: grafanaConfigured,
      reachable: false
    },
    influxdb: {
      configured: influxConfigured,
      reachable: false
    },
    collector: {
      timerActive: false,
      timerEnabled: false
    }
  };

  try {
    const health = execSync(`curl -fsS http://127.0.0.1:${GRAFANA_PORT}/api/health >/dev/null && echo OK || echo FAIL`, { encoding: "utf-8", timeout: 3000 }).trim();
    status.grafana.reachable = health === "OK";
  } catch {}

  try {
    const ping = execSync("curl -fsS http://127.0.0.1:8086/ping >/dev/null && echo OK || echo FAIL", { encoding: "utf-8", timeout: 3000 }).trim();
    status.influxdb.reachable = ping === "OK";
  } catch {}

  try {
    status.collector.timerActive = execSync("systemctl is-active sidekick-metrics.timer 2>/dev/null || true", { encoding: "utf-8", timeout: 3000 }).trim() === "active";
    status.collector.timerEnabled = execSync("systemctl is-enabled sidekick-metrics.timer 2>/dev/null || true", { encoding: "utf-8", timeout: 3000 }).trim() === "enabled";
  } catch {}

  const issues = [];
  if (!status.grafana.configured) issues.push("SIDEKICK_GRAFANA_ADMIN_USER is not configured for the Grafana auth proxy");
  if (!status.grafana.reachable) issues.push("Grafana is not reachable on localhost");
  if (!status.influxdb.configured) issues.push("SIDEKICK_INFLUX_TOKEN is not configured for metrics collection");
  if (!status.influxdb.reachable) issues.push("InfluxDB is not reachable on localhost");
  if (!status.collector.timerActive) issues.push("sidekick-metrics.timer is not active");
  status.ok = issues.length === 0;
  status.issues = issues;
  res.json(status);
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

app.get("/api/blackbox/profiles", (req, res) => {
  res.json({ profiles: blackbox.PROFILE_INFO });
});

app.get("/api/blackbox/storage", (req, res) => blackboxJson(res, () => blackbox.storageStatus()));

app.get("/api/blackbox/incidents", (req, res) => blackboxJson(res, () => ({ incidents: blackbox.listIncidents(req.query) })));

app.post("/api/blackbox/capture", async (req, res) => {
  try {
    const capture = await blackbox.captureIncident({ ...(req.body || {}), source: "dashboard", requested_by: "dashboard" });
    auditLog(req, 'blackbox.capture', { incident_id: capture.incident_id, capture_id: capture.id, state: capture.state });
    res.json({ ok: true, capture });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/blackbox/incidents/:id", (req, res) => blackboxJson(res, () => {
  const incident = blackbox.getIncident(req.params.id, { includeTimeline: true, includeAnalysis: true });
  if (!incident) {
    res.status(404);
    return { error: "Incident not found" };
  }
  return { incident };
}));

app.patch("/api/blackbox/incidents/:id", (req, res) => blackboxJson(res, () => {
  const incident = blackbox.updateIncident(req.params.id, req.body || {}, "dashboard");
  auditLog(req, 'blackbox.update', { incident_id: req.params.id, updates: Object.keys(req.body || {}) });
  return { ok: true, incident };
}));

app.delete("/api/blackbox/incidents/:id", (req, res) => blackboxJson(res, () => {
  const ok = blackbox.deleteIncident(req.params.id, "dashboard");
  auditLog(req, 'blackbox.delete', { incident_id: req.params.id, ok });
  return { ok };
}));

app.get("/api/blackbox/incidents/:id/timeline", (req, res) => blackboxJson(res, () => ({ timeline: blackbox.getTimeline(req.params.id) })));

app.get("/api/blackbox/incidents/:id/export", (req, res) => blackboxJson(res, () => ({ export: blackbox.exportIncident(req.params.id, { format: req.query.format || "json" }) })));

app.post("/api/blackbox/incidents/:id/analyze", async (req, res) => {
  try {
    const analysis = await blackbox.analyzeIncident(req.params.id, { ...(req.body || {}), actor: "dashboard" });
    auditLog(req, 'blackbox.analyze', { incident_id: req.params.id, analysis_id: analysis.id });
    res.json({ ok: true, analysis });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/blackbox/incidents/:id/notes", (req, res) => blackboxJson(res, () => {
  const note = blackbox.addNote(req.params.id, { ...(req.body || {}), source: "dashboard" });
  auditLog(req, 'blackbox.note', { incident_id: req.params.id, note_id: note.id });
  return { ok: true, note };
}));

app.get("/api/blackbox/captures/:id", (req, res) => blackboxJson(res, () => ({ capture: blackbox.getCapture(req.params.id, { includeSources: true }) })));

app.post("/api/blackbox/captures/:id/cancel", (req, res) => blackboxJson(res, () => blackbox.cancelCapture(req.params.id)));

app.get("/api/blackbox/captures/:id/stream", (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(blackbox.captureStatus(req.params.id))}\n\n`);
  const unsubscribe = blackbox.subscribeCapture(req.params.id, event => {
    res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
  });
  req.on('close', unsubscribe);
});

app.get("/api/blackbox/sources/:id", (req, res) => blackboxJson(res, () => ({ source: blackbox.getSource(req.params.id, { offset: Number(req.query.offset || 0), limit: Number(req.query.limit || 65536) }) })));

app.get("/api/blackbox/search", (req, res) => blackboxJson(res, () => ({ results: blackbox.searchIncidents(req.query.q || req.query.query || "", req.query) })));

app.get("/api/blackbox/compare", (req, res) => blackboxJson(res, () => blackbox.compareCaptures(req.query.a, req.query.b)));

app.get("/api/blackbox/purge-preview", (req, res) => blackboxJson(res, () => blackbox.purgePreview()));

app.post("/api/blackbox/purge", (req, res) => blackboxJson(res, () => {
  const result = blackbox.purgeExpired({ confirm: !!(req.body && req.body.confirm) });
  auditLog(req, 'blackbox.purge', result);
  return result;
}));

app.get("/api/evolve", (req, res) => {
  const capabilities = dbStore.listGeneratedCapabilities({ includeInactive: true }).map(cap => ["trial", "active"].includes(cap.state) ? (dbStore.syncGeneratedCapabilityStats(cap.id) || cap) : cap);
  res.json({
    ok: true,
    capabilities: capabilities.map(cap => ({
      id: cap.id,
      candidate_title: cap.title,
      proposed_tool_name: cap.name,
      lifecycle_state: cap.state,
      evidence_count: cap.evidenceCount || (cap.evidence || []).length,
      success_rate: cap.successRate,
      usefulness_score: cap.usefulnessScore,
      estimated_calls_saved: cap.estimatedCallsSaved,
      risk: cap.risk,
      inferred_parameters: cap.parameters,
      schema: cap.schema,
      validation_status: cap.validation ? (cap.validation.passed ? "passed" : "failed") : "not_validated",
      recent_trial_results: dbStore.listGeneratedToolAudit(cap.id, 5),
      recent_executions: dbStore.listGeneratedToolExecutions({ capabilityId: cap.id, limit: 5 }).map(shapeExecution),
      use_count: cap.useCount,
      success_count: cap.successCount,
      failure_count: cap.failureCount,
      duplicate_reasons: cap.duplicateReasons || [],
      quality_gates: cap.qualityGates || null,
      score_breakdown: cap.scoreBreakdown || null,
      allowed_actions: allowedActions(cap),
    }))
  });
});

async function evolveDashboardAction(req, res, action, extra = {}) {
  try {
    setSource("dashboard");
    auditLog(req, `evolve.${action}`, { id: req.params.id || req.body?.id || null });
    const result = await TOOLS.sidekick_evolve({ action, id: req.params.id || req.body?.id, ...(req.body || {}), ...extra });
    res.json({ ok: !result.isError, result: result.content?.[0]?.text || "" });
  } catch (error) {
    logError(req.originalUrl, 500, error, "evolve", req.headers["user-agent"]);
    res.status(500).json({ ok: false, error: error.message });
  }
}

app.post("/api/evolve/analyze", (req, res) => evolveDashboardAction(req, res, "analyze"));
app.post("/api/evolve/:id/validate", (req, res) => evolveDashboardAction(req, res, "validate"));
app.post("/api/evolve/:id/approve", (req, res) => evolveDashboardAction(req, res, "approve", { approver: "dashboard" }));
app.post("/api/evolve/:id/promote", (req, res) => evolveDashboardAction(req, res, "promote"));
app.post("/api/evolve/:id/reject", (req, res) => evolveDashboardAction(req, res, "reject"));
app.post("/api/evolve/:id/deprecate", (req, res) => evolveDashboardAction(req, res, "deprecate"));
app.post("/api/evolve/:id/feedback", (req, res) => evolveDashboardAction(req, res, "feedback"));

function shapeExecution(execution) {
  if (!execution) return null;
  return {
    id: execution.id,
    capability_id: execution.capabilityId,
    tool_name: execution.toolName,
    state: execution.state,
    source: execution.source,
    args: execution.args,
    success_criteria: execution.successCriteria,
    success_criteria_satisfied: execution.successCriteriaSatisfied,
    final_summary: execution.finalSummary,
    error_category: execution.errorCategory,
    cancel_requested: execution.cancelRequested,
    timeout_ms: execution.timeoutMs,
    started_at: execution.startedAt,
    completed_at: execution.completedAt,
    created_at: execution.createdAt,
    updated_at: execution.updatedAt,
    activity_url: `#activity?execution=${encodeURIComponent(execution.id)}`,
    steps: (execution.steps || []).map(step => ({
      id: step.id,
      execution_id: step.executionId,
      step_number: step.stepNumber,
      tool_name: step.toolName,
      state: step.state,
      args: step.args,
      started_at: step.startedAt,
      completed_at: step.completedAt,
      duration_ms: step.durationMs,
      result_summary: step.resultSummary,
      retry_count: step.retryCount,
      error_category: step.errorCategory,
      success: step.success,
    }))
  };
}

app.get("/api/evolve/executions", (req, res) => {
  const executions = dbStore.listGeneratedToolExecutions({ capabilityId: req.query.capability_id, limit: req.query.limit }).map(shapeExecution);
  res.json({ ok: true, executions });
});

app.get("/api/evolve/executions/:executionId", (req, res) => {
  const execution = dbStore.getGeneratedToolExecution(req.params.executionId);
  if (!execution) return res.status(404).json({ ok: false, error: "Execution not found" });
  res.json({ ok: true, execution: shapeExecution(execution) });
});

app.post("/api/evolve/:id/run", (req, res) => {
  const cap = dbStore.getGeneratedCapability(req.params.id) || dbStore.getGeneratedCapabilityByName(req.params.id);
  if (!cap || !["trial", "active"].includes(cap.state)) return res.status(400).json({ ok: false, error: "Generated tool is not trial or active" });
  const executionId = `gte_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  const timeoutMs = Number(req.body?.timeout_ms || 0) || null;
  setSource("dashboard");
  dbStore.createGeneratedToolExecution({
    id: executionId,
    capabilityId: cap.id,
    toolName: cap.name,
    state: "queued",
    source: "dashboard",
    args: req.body?.args || {},
    successCriteria: cap.successCriteria || "All generated workflow steps must complete successfully",
    timeoutMs,
  });
  setImmediate(async () => {
    try {
      await dynamicTools.callDynamicTool(cap.name, req.body?.args || {}, { callTool: require("./tools").callTool, source: "dashboard", executionId, timeoutMs });
    } catch (error) {
      dbStore.updateGeneratedToolExecution(executionId, {
        state: "failed",
        completedAt: new Date().toISOString(),
        finalSummary: redactSensitive(error.message),
        errorCategory: "error",
        successCriteriaSatisfied: false,
      });
    }
  });
  auditLog(req, "evolve.run", { id: cap.id, execution_id: executionId });
  res.json({ ok: true, execution_id: executionId, execution: shapeExecution(dbStore.getGeneratedToolExecution(executionId)) });
});

app.post("/api/evolve/executions/:executionId/cancel", (req, res) => {
  const execution = dynamicTools.cancelExecution(req.params.executionId);
  if (!execution) return res.status(404).json({ ok: false, error: "Execution not found" });
  auditLog(req, "evolve.cancel", { execution_id: execution.id });
  res.json({ ok: true, execution: shapeExecution(execution) });
});

app.get("/api/evolve/executions/:executionId/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  const send = execution => {
    if (execution.id !== req.params.executionId) return;
    res.write(`event: execution\ndata: ${JSON.stringify(shapeExecution(execution))}\n\n`);
  };
  const current = dbStore.getGeneratedToolExecution(req.params.executionId);
  if (current) res.write(`event: execution\ndata: ${JSON.stringify(shapeExecution(current))}\n\n`);
  const off = dynamicTools.onExecutionEvent(send);
  req.on("close", off);
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
      category: memoryCategory(m),
      project: m.project,
      content: m.content,
      summary: m.summary,
      tags: m.tags,
      confidence: m.confidence,
      importance: m.metadata?.importance || (m.confidence >= 0.8 ? "high" : m.confidence >= 0.55 ? "normal" : "low"),
      source: m.source,
      source_tool: m.source_tool,
      source_task_id: m.source_task_id,
      source_ref: m.source_ref,
      enabled: m.enabled,
      automatic: m.automatic,
      times_confirmed: m.times_confirmed,
      state: m.state || m.metadata?.state || "active",
      memory_class: m.memory_class,
      primary_scope_type: m.primary_scope_type,
      primary_scope_id: m.primary_scope_id,
      source_type: m.source_type,
      evidence_excerpt: m.evidence_excerpt,
      directness: m.directness,
      source_authority: m.source_authority,
      confidence_components: m.confidence_components,
      observed_at: m.observed_at,
      valid_from: m.valid_from,
      valid_to: m.valid_to,
      revalidate_after: m.revalidate_after,
      pinned: m.pinned,
      sensitivity: m.sensitivity,
      current: m.current,
      supersedes_id: m.supersedes_id,
      conflict_group: m.conflict_group,
      requires_confirmation: m.requires_confirmation,
      last_confirmed_at: m.last_confirmed_at,
      expires_at: m.expires_at,
      deleted_at: m.deleted_at,
      expired_at: m.expired_at,
      metadata: m.metadata || {},
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
    const stats = dbStore.getMemoryIntelligenceStats();
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

app.get("/api/handoffs", (req, res) => {
  try {
    res.json({ ok: true, handoffs: dbStore.listHandoffs({ project: req.query.project, includeArchived: req.query.include_archived === "true", limit: req.query.limit || 50 }) });
  } catch (error) {
    res.json({ ok: false, error: error.message, handoffs: [] });
  }
});

app.get("/api/handoffs/:id", (req, res) => {
  try {
    const handoff = dbStore.getHandoff(req.params.id);
    if (!handoff) return res.status(404).json({ ok: false, error: "Handoff not found" });
    const memories = dbStore.searchMemories({ project: handoff.project, includeDisabled: true, limit: 200 }).filter(memory => memory.source_ref === handoff.id || memory.metadata?.handoff_id === handoff.id);
    res.json({ ok: true, handoff, memories });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/api/memories/:id/evidence", (req, res) => {
  try {
    const memory = dbStore.getMemoryById(req.params.id, { includeDisabled: true });
    if (!memory) return res.status(404).json({ ok: false, error: "Memory not found" });
    res.json({ ok: true, memory, evidence: dbStore.getMemoryEvidence(req.params.id) });
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
