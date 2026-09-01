require("./env");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { timingSafeCompare } = require("./crypto-utils");
const { readSecret, hasSecret } = require("./core/runtime-secrets");
const { execFileSync } = require("child_process");
const { childProcessEnv } = require("./security/child-process");
const { callDashboardTool, getToolDefsForSource, getToolCategoriesWithTools, buildPolicyInspection, summarizePolicyInspection, enforceToolPolicy, listApprovals, resolveApproval, renderContinuationApprovalPreview, loadWatches, syncToolRegistry } = require("./tools");
const dynamicTools = require("./dynamic-tools");

// Restore persisted platform modules in this process so module tools resolve
// through the registry here as well (each process holds its own loader state).
try {
  const builtinModules = require("./modules/builtin-modules");
  builtinModules.provisionBuiltinModules();
  builtinModules.startModuleHealthChecks();
  builtinModules.startModuleReconciliation();
} catch (error) {
  console.error("[Modules] Builtin module provisioning failed:", error.message);
}
const dbStore = require("./db");
const identity = require("./core/identity");
const authentication = require("./core/authentication");
const { AuthRateLimiter } = require("./core/auth-rate-limit");
const authorization = require("./core/authorization");
const { allowedActions } = require("./evolve/lifecycle");
const { redactSensitive } = require("./redact");
const crypto = require("crypto");
const blackbox = require("./blackbox");
const predictEngine = require("./predict");
const platformKernel = require("./platform/kernel");
const compute = require("./compute");
const { probeConnector } = require("./connectors/health");
const { registerConnectorRoutes } = require("./dashboard/connectors-routes");
const { registerKvRoutes } = require("./dashboard/kv-routes");
const { registerMemoryReadRoutes } = require("./dashboard/memory-read-routes");
const { registerSyncRoutes } = require("./dashboard/sync-routes");
const { registerSystemRoutes } = require("./dashboard/system-routes");
const { registerLogsRoute } = require("./dashboard/logs-route");
const { registerApprovalRoutes } = require("./dashboard/approval-routes");
const { registerQuickActionsRoute } = require("./dashboard/quick-actions-route");
const { registerStatsToolsRoutes } = require("./dashboard/stats-tools-routes");
const { registerSummaryRoute } = require("./dashboard/summary-route");
const { registerResearchSourceRoutes } = require("./dashboard/research-source-routes");
const { registerNetworkScopeRoutes } = require("./dashboard/network-scope-routes");
const { registerDatabaseRoutes } = require("./dashboard/database-routes");
const { registerAgentProxyRoutes } = require("./dashboard/agent-proxy-routes");
const { registerBlackboxRoutes } = require("./dashboard/blackbox-routes");
const { registerPredictRoutes } = require("./dashboard/predict-routes");
const { registerCapabilityRoutes } = require("./dashboard/capability-routes");
const { registerEvolveRoutes } = require("./dashboard/evolve-routes");
const { runDoctor, formatDoctorText, createSupportBundle } = require("./doctor");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const PORT = parseInt(process.env.SIDEKICK_DASHBOARD_PORT || "4098", 10);
const BIND_HOST = process.env.SIDEKICK_DASHBOARD_BIND_HOST || "127.0.0.1";
if (["0.0.0.0", "::"].includes(BIND_HOST) && process.env.SIDEKICK_ALLOW_PUBLIC_BIND !== "1") {
  throw new Error("wildcard Dashboard bind requires SIDEKICK_ALLOW_PUBLIC_BIND=1");
}
const BOOTSTRAP_TOKEN = readSecret("SIDEKICK_BOOTSTRAP_TOKEN");
const REMOTE_BOOTSTRAP_REQUIRED = !["127.0.0.1", "::1", "localhost"].includes(BIND_HOST);
const MCP_PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const GRAFANA_PORT = parseInt(process.env.SIDEKICK_GRAFANA_PORT || "3000", 10);
const MCP_API_KEY = readSecret("SIDEKICK_API_KEY", { required: true });
if (!MCP_API_KEY || MCP_API_KEY === "sk-sidekick-local-dev" || MCP_API_KEY === "sk-your-key-here") {
  throw new Error("SIDEKICK_API_KEY must be set to a non-placeholder value");
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// The dashboard is a separate process in production. Converge migrations here
// as well as in the MCP process so authentication routes never race startup.
dbStore.runPendingMigrations();
syncToolRegistry();

const app = express();
// Forwarded headers are only authoritative when the deployment explicitly
// declares a trusted reverse proxy. Treating a client-supplied
// X-Forwarded-Proto as truth can otherwise make an HTTP session look secure
// (or make origin checks compare against attacker-controlled scheme data).
const TRUST_PROXY = process.env.SIDEKICK_DASHBOARD_TRUST_PROXY === "true";
app.set("trust proxy", TRUST_PROXY);
app.disable("x-powered-by");

// Establish browser-facing security invariants in one place. Grafana is a
// separately rendered application and keeps its own response policy.
app.use((req, res, next) => {
  const isGrafana = req.path.startsWith("/grafana/") || req.path === "/grafana";
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (!isGrafana) {
    res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'");
  }
  if (req.path === "/" || req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use("/static", express.static(path.join(__dirname, "..", "static")));
app.use(express.json({ limit: "1mb" }));
const http = require("http");
const AGENT_PORT = parseInt(process.env.SIDEKICK_AGENT_PORT || "4099", 10);

// First non-internal IPv4 of a local interface. That is a PRIVATE address on
// any NAT'd deployment — it was previously mislabeled as the public IP too.
// The honest public value is "unknown" unless something real determines it;
// no external lookup is performed.
function getPrivateIPv4() {
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
const VPS_IP = getPrivateIPv4();

function runCommand(program, args = [], opts = {}) {
  try {
    return execFileSync(program, args, { encoding: "utf-8", timeout: 5000, ...opts, env: childProcessEnv(opts.env) }).trim();
  } catch { return "?"; }
}

function parseMemInfo() {
  try {
    return Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf-8").split("\n").filter(Boolean).map(line => {
      const match = line.match(/^([^:]+):\s+(\d+)\s*(\w+)?/);
      return match ? [match[1], { value: Number(match[2]), unit: match[3] || "" }] : null;
    }).filter(Boolean));
  } catch { return {}; }
}

function formatKb(entry) {
  if (!entry || !Number.isFinite(entry.value)) return "?";
  if (entry.unit === "kB") return `${entry.value} kB`;
  return String(entry.value);
}

function parseDiskRoot() {
  const output = runCommand("df", ["-h", "/"]);
  const line = output.split("\n")[1] || "";
  const parts = line.trim().split(/\s+/);
  return {
    total: parts[1] || "?",
    used: parts[2] || "?",
    free: parts[3] || "?",
    pct: parts[4] || "?"
  };
}

function parseLoadAverage() {
  try {
    return fs.readFileSync("/proc/loadavg", "utf-8").trim().split(/\s+/).slice(0, 3).join(" ");
  } catch { return os.loadavg().map(n => n.toFixed(2)).join(" "); }
}

function systemctlStatus(unit, action = "is-active") {
  const status = runCommand("systemctl", [action, unit], { timeout: 3000 });
  return status === "?" ? "inactive" : status;
}

function systemSnapshot() {
  const memInfo = parseMemInfo();
  const totalKb = memInfo.MemTotal?.value || 0;
  const availableKb = memInfo.MemAvailable?.value || 0;
  const usedKb = totalKb && availableKb ? totalKb - availableKb : 0;
  const memPct = totalKb ? Math.round((usedKb / totalKb) * 100) : 0;
  const disk = parseDiskRoot();
  // os.loadavg()[0] is the 1-minute LOAD AVERAGE, not a CPU percentage — it
  // was previously rendered with a "%" suffix, which faked a percent. It is
  // now reported as what it is, with the core count so consumers can judge
  // pressure (load ≈ cores means saturated).
  const load1m = Number((os.loadavg()[0] || 0).toFixed(2));
  const cpuCount = os.cpus().length || 1;
  return {
    uptime: runCommand("uptime", ["-p"]),
    memory: { total: formatKb(memInfo.MemTotal), used: usedKb ? `${usedKb} kB` : "?", free: formatKb(memInfo.MemAvailable), pct: `${memPct}%`, pctNumber: memPct },
    disk,
    load_1m: load1m,
    cpu_count: cpuCount,
    load: parseLoadAverage()
  };
}

const DASHBOARD_USER = process.env.SIDEKICK_DASHBOARD_USER || "";
const DASHBOARD_PASS = readSecret("SIDEKICK_DASHBOARD_PASS");
const DASHBOARD_ALLOWED_IPS = (process.env.SIDEKICK_DASHBOARD_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
const GRAFANA_USER = process.env.SIDEKICK_GRAFANA_ADMIN_USER || "sidekick";
const GRAFANA_PASS = readSecret("SIDEKICK_GRAFANA_ADMIN_PASSWORD");

// Legacy signed-cookie compatibility remains available only for the configured
// dashboard Basic Auth account. Identity sessions below are server-side and
// revocable; they are the normal local-user path.
const SESSION_SECRET = readSecret("SIDEKICK_SECRET_KEY") || crypto.randomBytes(32).toString("hex");
const SESSION_TTL = 86400000;
const authRateLimiter = new AuthRateLimiter();

function authAttemptKeys(req, username = "") {
  const address = req.ip || req.socket?.remoteAddress || "unknown";
  return [
    `ip|${address}`,
    `account|${address}|${String(username).trim().toLowerCase().slice(0, 160)}`
  ];
}

function rejectIfAuthThrottled(req, res, keys) {
  const decisions = keys.map(key => authRateLimiter.check(key));
  const decision = decisions.find(item => !item.allowed);
  if (!decision) return false;
  res.set("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
  res.status(429).json({ error: "Too many authentication attempts", code: "auth_rate_limited" });
  return true;
}

function recordAuthFailure(req, keys) {
  for (const key of keys) authRateLimiter.recordFailure(key);
}

function clearAuthFailures(keys) {
  for (const key of keys) authRateLimiter.clear(key);
}

// The dashboard Basic Auth account predates the identity service. Adopt its
// existing bridge principal as the same human identity once the configured
// dashboard credentials have authenticated. This avoids creating a second
// personal account while preserving the existing administrator role.
function legacyDashboardPrincipal(username, password = null) {
  if (!username) return null;
  try {
    const db = dbStore.getDb();
    const rows = db.prepare("SELECT * FROM principals WHERE json_extract(metadata_json, '$.legacy_dashboard_username') = ? LIMIT 1").all(username);
    const row = rows[0] || null;
    if (row && row.principal_type === "human") return promoteFirstDashboardOwner(identity.getPrincipal(row.principal_id));
    if (row && !password) return identity.getPrincipal(row.principal_id);

    if (row) {
      const metadata = JSON.parse(row.metadata_json || "{}");
      metadata.adopted_legacy_dashboard = true;
      // The legacy Dashboard credential is an independent Basic Auth secret
      // and may not satisfy the local identity password policy. Never reuse
      // or weaken that credential; adoption gets an unexposed random secret
      // that can be changed through the normal identity flow.
      const passwordHash = identity.passwordHash(crypto.randomBytes(32).toString("base64url"));
      const adopt = db.transaction(() => {
        db.prepare("UPDATE principals SET principal_type = 'human', metadata_json = ?, updated_at = ? WHERE principal_id = ?")
          .run(JSON.stringify(metadata), new Date().toISOString(), row.principal_id);
        db.prepare("INSERT INTO human_users (principal_id, username, password_hash, password_scheme, password_changed_at) VALUES (?, ?, ?, ?, ?)")
          .run(row.principal_id, username, passwordHash, identity.PASSWORD_SCHEME, new Date().toISOString());
      });
      adopt();
      return promoteFirstDashboardOwner(identity.getPrincipal(row.principal_id));
    }

    if (!password) return null;
    const hasOwner = Boolean(db.prepare("SELECT 1 FROM principal_roles WHERE role_name = 'owner' LIMIT 1").get());
    if (!hasOwner) {
      return identity.bootstrapOwner({
        username,
        password: crypto.randomBytes(32).toString("base64url"),
        displayName: username,
        metadata: { legacy_dashboard_username: username, adopted_legacy_dashboard: true },
      });
    }
    const principal = identity.createHumanUser({
      username,
      password: crypto.randomBytes(32).toString("base64url"),
      displayName: username,
      metadata: { legacy_dashboard_username: username, adopted_legacy_dashboard: true },
    });
    return identity.assignRole(principal.principal_id, "administrator");
  } catch {
    return null;
  }
}

function promoteFirstDashboardOwner(principal) {
  if (!principal || !principal.metadata?.adopted_legacy_dashboard) return principal;
  try {
    const db = dbStore.getDb();
    if (!db.prepare("SELECT 1 FROM principal_roles WHERE role_name = 'owner' LIMIT 1").get()) {
      return identity.assignRole(principal.principal_id, "owner", principal.principal_id);
    }
  } catch {}
  return principal;
}

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

function requestProtocol(req) {
  return req?.secure || req?.protocol === "https" ? "https" : "http";
}

function isSameOrigin(origin, host, protocol = "http") {
  if (!origin || !host || !protocol) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === `${protocol}:` && parsed.host === host;
  } catch {
    return false;
  }
}

function requestCookie(req, name) {
  const prefix = `${name}=`;
  return String(req.headers.cookie || "").split(";").map(value => value.trim())
    .find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function setIdentityCookie(res, token, maxAge = Math.floor(authentication.SESSION_TTL_MS / 1000), req = null) {
  const secure = Boolean(req?.secure);
  res.setHeader("Set-Cookie", `sidekick_identity=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}

function clearIdentityCookie(res) {
  res.setHeader("Set-Cookie", "sidekick_identity=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

// Audit logging
const AUDIT_LOG = path.join(DATA_DIR, 'audit.jsonl');
function auditLog(req, action, details, actor = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    key: req.params.key || null,
    ip: req.ip,
    user: actor || (() => {
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

function dashboardActor(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) return Buffer.from(auth.slice(6), 'base64').toString().split(':')[0];
  return 'anonymous';
}

function startDashboardExecution(req, action) {
  try {
    const execution = platformKernel.createExecution({
      actor_id: dashboardActor(req),
      client_id: req.ip,
      trigger_type: "dashboard",
      operation_type: "dashboard_action",
      tool_name: "sidekick_dashboard",
      tool_action: action,
      resource_scope: req.originalUrl || req.path,
      environment: process.env.SIDEKICK_ENVIRONMENT || null,
      risk: action === "restart-agent" ? "high" : "low",
      source: "dashboard",
      metadata: {
        method: req.method,
        path: req.originalUrl || req.path,
      },
    });
    return platformKernel.transitionExecution(execution.execution_id, "running", { source: "dashboard", reason: "dashboard action started" });
  } catch {
    return null;
  }
}

function finishDashboardExecution(execution, state, details = {}) {
  if (!execution) return;
  try {
    platformKernel.transitionExecution(execution.execution_id, state, {
      source: "dashboard",
      actor_id: execution.actor_id,
      result_status: details.result_status || state,
      error_category: details.error_category || null,
      result_summary: details.result_summary || null,
      reason: details.reason || null,
    });
  } catch {
    // Dashboard actions should not fail because platform observability is unavailable.
  }
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
    if (origin && !isSameOrigin(origin, host, requestProtocol(req))) {
      return res.status(403).json({ error: 'Invalid origin' });
    }
    // Modern browsers send Fetch Metadata even when Origin is omitted. Reject
    // an explicitly cross-site mutation rather than relying on the caller to
    // provide Origin. This preserves non-browser API clients that omit both
    // headers while closing the browser CSRF path.
    if (!origin && String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site request refused' });
    }
    // Once a dashboard session cookie is present, an originless mutation is
    // ambiguous and must fail closed. Basic-auth clients without a cookie keep
    // their existing compatibility behavior and are covered by Fetch Metadata
    // when used from a browser.
    if (!origin && (requestCookie(req, 'sidekick_identity') || requestCookie(req, 'sidekick_sid'))) {
      return res.status(403).json({ error: 'Origin required for authenticated state changes' });
    }
  }
  next();
});

/**
 * The authenticated principal for this request, or null when the dashboard is
 * running without authentication configured.
 *
 * ADR docs/adr-approval-continuation.md §8.2 / invariant I19: an approval and
 * especially a reconciliation must record a REAL PRINCIPAL. `reviewer` used to
 * be hardcoded to the literal "dashboard", which made it impossible to
 * determine from the record which human approved anything — and a
 * reconciliation attributed to "dashboard" is indistinguishable from an
 * unattributed one.
 *
 * Returning null rather than a placeholder is deliberate: callers that require
 * an attributable human must FAIL CLOSED, and a fallback string would silently
 * defeat that.
 */
function authenticatedUser(req) {
  return (req && typeof req.authUser === "string" && req.authUser) ? req.authUser : null;
}

function bootstrapCompleted() {
  return Boolean(dbStore.getDb().prepare("SELECT 1 FROM identity_bootstrap WHERE singleton_id = 1").get());
}

const { registerAuthRoutes } = require("./dashboard/auth-routes");
const { requireIdentityPermission, requireIdentityAdministrator } = registerAuthRoutes({
  app,
  dbStore,
  identity,
  authentication,
  authorization,
  timingSafeCompare,
  dashboardUser: DASHBOARD_USER,
  dashboardPass: DASHBOARD_PASS,
  bootstrapCompleted,
  authAttemptKeys,
  rejectIfAuthThrottled,
  recordAuthFailure,
  clearAuthFailures,
  legacyDashboardPrincipal,
  setIdentityCookie,
  clearIdentityCookie,
  requestCookie,
  verifySessionToken,
  makeSessionToken,
  bootstrapToken: BOOTSTRAP_TOKEN,
  remoteBootstrapAllowed: REMOTE_BOOTSTRAP_REQUIRED,
});

// Grafana auth-proxy mode does not create a Grafana session token. Do not
// report a fake rotation success: callers must treat this operation as
// unsupported and continue using the authenticated proxy header.
app.post('/grafana/api/user/auth-tokens/rotate', (req, res) => {
  res.status(501).json({
    error: "Grafana auth-proxy token rotation is not supported",
    code: "unsupported_operation"
  });
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

// Read-only, bounded Doctor diagnostics. Authentication is provided by the
// dashboard middleware registered above; this route deliberately accepts no
// targets, probes, or mutation options.
app.get("/api/doctor", (req, res) => {
  const format = String(req.query.format || "json").toLowerCase();
  if (!new Set(["json", "text"]).has(format)) {
    return res.status(400).json({ ok: false, error: "format must be json or text", code: "invalid_format" });
  }
  try {
    const report = runDoctor();
    res.set("Cache-Control", "no-store");
    if (format === "text") return res.type("text/plain").send(formatDoctorText(report));
    return res.json(createSupportBundle({ report }));
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Doctor diagnostics unavailable", code: "doctor_failed" });
  }
});

function readKV() {
  return dbStore.loadKV({});
}

function dashboardExecutionMetadata(req, actor, extra = {}) {
  const header = name => req?.headers?.[name] || req?.headers?.[name.toLowerCase()] || null;
  const cookie = String(header("cookie") || "");
  const sessionCookie = cookie.split(";").map(value => value.trim())
    .find(value => value.startsWith("sidekick_sid="));
  const sessionId = header("x-sidekick-session-id") ||
    (sessionCookie ? "dashboard:" + crypto.createHash("sha256").update(sessionCookie).digest("hex").slice(0, 24) : null);
  const body = req?.body && typeof req.body === "object" ? req.body : {};
  return {
    actor,
    authIdentity: req?.authPrincipal ? {
      principal_id: req.authPrincipal.principal_id,
      principal_type: req.authPrincipal.principal_type,
      scopes: null,
      authentication_method: "browser_session",
      delegation_id: req.authPrincipal.delegation_id || null,
    } : null,
    sessionId,
    project: body.project || req?.query?.project || header("x-sidekick-project") || null,
    taskId: body.task_id || body.taskId || req?.query?.task_id || header("x-sidekick-task-id") || null,
    requestId: header("x-request-id") || null,
    ...extra,
  };
}

function blackboxJson(res, fn) {
  try {
    res.json(fn());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function governedDashboardMutation(req, res, tool, args, auditAction) {
  // The dashboard middleware already authenticates the request. The dispatcher
  // receives the real user when available, while compatibility clients retain
  // the established dashboard actor for medium-risk mutations; critical-risk
  // routes use requireAttributedActor at their dedicated boundaries.
  const actor = authenticatedUser(req) || "dashboard";
  try {
    auditLog(req, auditAction, { tool, action: args.action, id: args.incident_id || args.capture_id || args.id || null });
    const result = await callDashboardTool(tool, args, dashboardExecutionMetadata(req, actor));
    if (!result?.isError && tool === "compute_nodes") {
      const text = result.content?.[0]?.text || "";
      let payload; try { payload = JSON.parse(text); } catch { payload = { message: text }; }
      if (["maintenance", "revoke"].includes(args.action)) return res.json({ ok: true, worker: payload });
      if (args.action === "create_token") return res.json({ ok: true, ...payload, install: computeInstallInfo(req, payload.token) });
    }
    if (!result?.isError && tool === "compute_jobs") {
      const text = result.content?.[0]?.text || "";
      let payload; try { payload = JSON.parse(text); } catch { payload = { message: text }; }
      if (["cancel", "retry"].includes(args.action)) return res.json({ ok: true, job: payload });
      if (args.action === "recover") return res.json({ ok: true, recovered: payload.recovered, expired: payload.expired });
    }
    if (!result?.isError && tool === "black_box") {
      const text = result.content?.[0]?.text || "";
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { message: text }; }
      const wrapped = {
        capture: ["capture", "retry_capture"].includes(args.action) ? payload : undefined,
        analysis: args.action === "analyze" ? payload : undefined,
        incident: args.action === "update_incident" ? payload : undefined,
        note: args.action === "add_note" ? payload : undefined,
      };
      if (Object.values(wrapped).some(value => value !== undefined)) return res.json({ ok: true, ...wrapped });
    }
    return capabilityResult(res, result);
  } catch (error) {
    logError(req.originalUrl, 500, error, tool, req.headers["user-agent"]);
    return res.status(500).json({ ok: false, error: error.message });
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

function memoryCategory(memory) {
  if (memory.type === "tool_call" || memory.source_tool && memory.type === "observation" && memory.source_tool !== "sidekick_agent") return "operational";
  if (memory.type === "session" || memory.type === "agent_task") return "sessions";
  if (memory.type === "open_thread" || memory.state === "pending") return "unresolved";
  return "durable";
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
    "server:hostname": os.hostname(),
    "server:os": (() => { try { const osRelease = fs.readFileSync("/etc/os-release", "utf-8"); return osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] || os.type(); } catch { return os.type(); } })(),
    "server:kernel": os.release(),
    "server:arch": os.arch(),
    "server:cpu": os.cpus()[0]?.model || "?",
    "server:memory_total": formatKb(parseMemInfo().MemTotal),
    "server:swap_total": formatKb(parseMemInfo().SwapTotal),
    "server:disk_total_root": parseDiskRoot().total,
    "server:processes": (() => { const ps = runCommand("ps", ["-e", "--no-headers"]); return ps === "?" ? "?" : String(ps.split("\n").filter(Boolean).length); })(),
    "server:uptime_at_start": runCommand("uptime", ["-p"]),

    // public_ip stays "unknown" deliberately: the first non-internal local
    // IPv4 is the private address, and nothing here performs the external
    // lookup that a real public value would require.
    "network:public_ip": "unknown",
    "network:private_ip": getPrivateIPv4(),
    "network:interfaces": Object.keys(os.networkInterfaces()).join(","),
    "network:dns": (() => { try { return fs.readFileSync("/etc/resolv.conf", "utf-8").split("\n").map(line => line.match(/^nameserver\s+(\S+)/)?.[1]).filter(Boolean).join(","); } catch { return "?"; } })(),
    "network:gateway": (() => { const route = runCommand("ip", ["route", "show", "default"]); return route.match(/\bvia\s+(\S+)/)?.[1] || "?"; })(),

    "services:sidekick-mcp": systemctlStatus("sidekick-mcp"),
    "services:sidekick-dashboard": systemctlStatus("sidekick-dashboard"),
    "services:sidekick-agent": systemctlStatus("sidekick-agent"),
    "services:ollama": systemctlStatus("ollama"),

    "security:ufw": systemctlStatus("ufw"),
    "security:fail2ban": systemctlStatus("fail2ban"),
    "security:ssh_port": (() => { try { const c = fs.readFileSync("/etc/ssh/sshd_config","utf-8").match(/^Port\s+(\d+)/m); return c ? c[1] : "22"; } catch { return "22"; } })(),
    "security:last_login": "[redacted on startup]",
    "security:failed_logins": "[redacted on startup]",

    "software:node_version": process.version,
    "software:npm_version": runCommand("npm", ["--version"]),
    "software:ollama_version": runCommand("ollama", ["--version"]),
    "software:python_version": runCommand("python3", ["--version"]),

    "deploy:git_commit": versionInfo.commit || "?",
    "deploy:branch": versionInfo.branch || "?",
    "deploy:remote_url": versionInfo.remote_url || "?",
    "deploy:initialized": now,

    "config:timezone": runCommand("timedatectl", ["show", "-p", "Timezone", "--value"]),
    "config:locale": (() => { try { return fs.readFileSync("/etc/default/locale", "utf-8").match(/^LANG=(.+)$/m)?.[1] || "C.UTF-8"; } catch { return "C.UTF-8"; } })(),
    "config:env": process.env.NODE_ENV || "production",
  };

  for (const [key, value] of Object.entries(seed)) {
    const existing = kv[key];
    kv[key] = {
      value,
      project: "system",
      source: "dashboard",
      created: existing?.created || now,
      updated: now,
    };
  }

  const stale = Object.keys(kv).filter(k => k.startsWith("security:failed_logins_24h"));
  stale.forEach(k => delete kv[k]);
  writeKV(kv);
  console.log("Seed KV written with", Object.keys(seed).length, "keys");
}

registerLogsRoute({ app, dbStore, normalizeLogEntry, buildActivitySessions, summarizeActivity, fallbackGapMs: ACTIVITY_FALLBACK_GAP_MS });

async function dashboardSummaryHandler(req, res) {
  try {
    // Health score calculation
    const snapshot = systemSnapshot();
    // Load pressure as percent-of-cores: the honest analogue of the old fake
    // "CPU %" (which was the raw 1m load average with a % sign). 100 means the
    // 1-minute load equals the core count, i.e. saturation.
    const load1m = snapshot.load_1m;
    const cpuCount = snapshot.cpu_count;
    const loadPctOfCores = cpuCount ? Math.round((load1m / cpuCount) * 100) : 0;
    const memPct = snapshot.memory.pctNumber;
    const diskPct = parseFloat(snapshot.disk.pct) || 0;

    let moduleHealth = { total: 0, healthy: 0, issues: 0, modules: [] };
    try {
      const repository = require("./modules/repository");
      const loader = require("./modules/loader");
      const modules = repository.listModules();
      const rows = modules.map(record => ({
        name: record.name,
        state: record.state,
        active_in_process: loader.isModuleActive(record.name),
        health: record.health || {},
        last_health_check_at: record.last_health_check_at || null,
        health_history: repository.listHealthHistory(record.name, 5),
        error: record.error || null,
      }));
      moduleHealth = {
        total: rows.length,
        healthy: rows.filter(row => row.state === "healthy").length,
        issues: rows.filter(row => row.state === "error" || ((row.state === "enabled" || row.state === "healthy") && !row.active_in_process)).length,
        modules: rows,
      };
    } catch {}
    
    // Calculate health score (100 = perfect, deduct for high usage). Load
    // thresholds are percent-of-cores, consistent with the metric's new
    // meaning: >100 saturated, >70 elevated.
    let healthScore = 100;
    if (loadPctOfCores > 100) healthScore -= 30;
    else if (loadPctOfCores > 70) healthScore -= 15;
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
      // Watches persist to watches.json, not the documents table — the
      // document read always returned the empty fallback.
      const watchData = loadWatches();
      activeWatches = watchData.filter(w => w.status === "active").length;
    } catch {}
    
    let agentStatus = "idle";
    try {
      const agentData = await getJsonFromLocalService(AGENT_PORT, "/api/agent/status");
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
        // Load average (1m), core count, and load as percent-of-cores. The
        // old `cpu` field was the raw load average masquerading as a percent.
        load_1m: load1m,
        cpu_count: cpuCount,
        load_pct_of_cores: loadPctOfCores,
        memory: memPct,
        disk: diskPct,
        modules: moduleHealth,
      },
      // The canned toolStats {calls:0,...} placeholder is gone: it was never
      // real data, and the client computes tool stats from /api/stats.
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
}

registerSummaryRoute({ app, handler: dashboardSummaryHandler });

registerResearchSourceRoutes({
  app,
  callDashboardTool,
  dashboardExecutionMetadata,
  authenticatedUser,
  auditLog,
  logError,
});

registerNetworkScopeRoutes({
  app,
  authenticatedUser,
  requireIdentityAdministrator,
  auditLog,
  logError,
});

app.get("/api/artifacts", (req, res) => {
  // The normal dashboard middleware rejects unauthenticated production
  // requests. Keep the route's authorization explicit for authenticated
  // identity principals, while allowing isolated pre-bootstrap test harnesses
  // to exercise the handler without manufacturing an Owner account.
  if (req.authPrincipal && !requireIdentityAdministrator(req, res)) return;
  // Artifact metadata is a project resource. An authenticated Dashboard
  // request must name its project and only sees artifacts owned or created by
  // the requesting principal; internal custody callers may remain unscoped.
  if (req.authPrincipal && !req.query.project_id) return res.status(400).json({ ok: false, error: "project_id is required for artifact access", code: "project_scope_required" });
  try {
    const artifacts = platformKernel.listArtifacts({
      project_id: req.query.project_id,
      principal_id: req.authPrincipal?.principal_id,
      execution_id: req.query.execution_id,
      custody_role: req.query.custody_role,
      limit: req.query.limit,
    });
    res.json({
      ok: true,
      artifacts,
      total: artifacts.length,
      summary: {
        originals: artifacts.filter(artifact => artifact.custody_role === "original").length,
        derivatives: artifacts.filter(artifact => artifact.custody_role === "derivative").length,
      },
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// Read-only, bounded semantic-repository projection. The request still goes
// through the canonical dispatcher so path policy, schema validation, audit,
// redaction, and tool authorization are not duplicated in the Dashboard.
app.get("/api/repository/semantic", async (req, res) => {
  if (req.authPrincipal && !requireIdentityAdministrator(req, res)) return;
  const limit = Number(req.query.limit || 20); const maxChars = Number(req.query.max_chars || 12000);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(maxChars) || maxChars < 1000 || maxChars > 60000) return res.status(400).json({ ok: false, error: "invalid bounded semantic query limits", code: "invalid_limits" });
  try {
    const result = await callDashboardTool("semantic_repo", { action: "query", path: req.query.path, query: String(req.query.query || "").slice(0, 500), level: Math.min(2, Math.max(0, Number(req.query.level || 0))), limit, max_chars: maxChars, cursor: req.query.cursor || undefined }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
    return capabilityResult(res, result);
  } catch (error) { return res.status(400).json({ ok: false, error: error.message, code: "semantic_query_failed" }); }
});

app.get("/api/event-deliveries", (req, res) => {
  try {
    const deliveries = platformKernel.listEventDeliveries({
      subscription_id: req.query.subscription_id,
      status: req.query.status,
      limit: req.query.limit,
    });
    res.json({
      ok: true,
      subscriptions: platformKernel.listEventSubscriptions(),
      deliveries,
      total: deliveries.length,
      stats: platformKernel.getEventDeliveryStats(),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/event-subscriptions", (req, res) => {
  const actor = authenticatedUser(req);
  if (!actor) return res.status(403).json({ ok: false, error: "Connector and event operations require an authenticated dashboard user" });
  try {
    const subscription = platformKernel.registerEventSubscription({ ...req.body, source: "dashboard" });
    auditLog(req, "event_subscription.register", { subscription_id: subscription.subscription_id, event_type: subscription.event_type, actor });
    res.json({ ok: true, subscription });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.post("/api/event-subscriptions/:subscriptionId/:action", (req, res) => {
  const actor = authenticatedUser(req);
  if (!actor) return res.status(403).json({ ok: false, error: "Event subscription operations require an authenticated dashboard user" });
  const state = req.params.action === "pause" ? "paused" : req.params.action === "resume" ? "active" : null;
  if (!state) return res.status(404).json({ ok: false, error: "unknown subscription action" });
  try {
    const subscription = platformKernel.setEventSubscriptionState(req.params.subscriptionId, state);
    auditLog(req, `event_subscription.${req.params.action}`, { subscription_id: subscription.subscription_id, actor });
    res.json({ ok: true, subscription });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.post("/api/event-deliveries/:deliveryId/requeue", (req, res) => {
  const actor = authenticatedUser(req);
  if (!actor) return res.status(403).json({ ok: false, error: "Delivery operations require an authenticated dashboard user" });
  try {
    const delivery = platformKernel.requeueEventDelivery(req.params.deliveryId);
    auditLog(req, "event_delivery.requeue", { delivery_id: delivery.delivery_id, actor });
    res.json({ ok: true, delivery });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

registerConnectorRoutes({
  app,
  platformKernel,
  probeConnector,
  authenticatedUser,
  startDashboardExecution,
  finishDashboardExecution,
  auditLog,
});

app.get("/api/scope-snapshots", (req, res) => {
  try {
    const snapshots = platformKernel.listScopeSnapshots({ project_id: req.query.project_id, state: req.query.state, limit: req.query.limit });
    res.json({ ok: true, snapshots, total: snapshots.length });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.post("/api/scope-snapshots", (req, res) => {
  const actor = authenticatedUser(req);
  if (!actor) return res.status(403).json({ ok: false, error: "Scope changes require an authenticated dashboard user" });
  try {
    const snapshot = platformKernel.createScopeSnapshot({ ...req.body, created_by: actor, source: "dashboard" });
    auditLog(req, "scope_snapshot.create", { snapshot_id: snapshot.snapshot_id, digest: snapshot.digest, target_count: snapshot.target_count, actor });
    res.json({ ok: true, snapshot });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.post("/api/scope-guard/evaluate", (req, res) => {
  const actor = authenticatedUser(req);
  if (!actor) return res.status(403).json({ ok: false, error: "Scope evaluation requires an authenticated dashboard user" });
  try {
    const decision = platformKernel.evaluateScope(req.body?.snapshot_id, req.body || {});
    auditLog(req, "scope_guard.evaluate", { snapshot_id: decision.snapshot_id, decision_digest: decision.decision_digest, ok: decision.ok, reason: decision.reason, actor });
    res.json({ ok: true, decision });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.get("/api/llm", (req, res) => {
  // Reflect the Compute provider/model registry — the inference authority — from
  // registry state rather than probing a single hardcoded Ollama endpoint. This
  // is a read-only view of what Compute will actually route to; it never becomes
  // a separate provider-configuration path.
  try {
    const providers = compute.providerRegistry.listProviders({ enabled: true });
    const models = [];
    for (const p of providers) {
      for (const m of compute.modelRegistry.listModels({ providerId: p.providerId, enabled: true })) {
        models.push({
          name: m.providerModelName,
          provider: p.displayName,
          providerType: p.providerType,
          capabilities: m.capabilities,
          health: p.health.status,
        });
      }
    }
    res.json({ status: models.length === 0 ? "no_models" : "ok", models });
  } catch (e) {
    res.json({ status: "unreachable", error: e.message });
  }
});

registerQuickActionsRoute({
  app,
  startDashboardExecution,
  finishDashboardExecution,
  systemctlStatus,
  systemSnapshot,
  dbStore,
  auditLog,
  callDashboardTool,
  dashboardExecutionMetadata,
  authenticatedUser,
  logError,
  fs,
  path,
  rootDir: path.join(__dirname, ".."),
});

registerSystemRoutes({
  app,
  systemSnapshot,
  systemctlStatus,
  getJsonFromLocalService,
  http,
  grafanaPort: GRAFANA_PORT,
  grafanaConfigured: Boolean(GRAFANA_USER),
  influxConfigured: Boolean(hasSecret("SIDEKICK_INFLUX_TOKEN") && readSecret("SIDEKICK_INFLUX_TOKEN") !== "sidekick-influx-token"),
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

registerKvRoutes({
  app,
  readKV,
  writeKV,
  safeString,
  summarizeValue,
  inferNamespace,
  valueSize,
  valueType,
  auditLog,
  requireIdentityAdministrator,
});

registerStatsToolsRoutes({ app, dbStore, getToolDefsForSource });

app.get("/api/tool-policy", (req, res) => {
  const sources = String(req.query.source || "mcp,dashboard,agent").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  // A single-source inspection must use that source's live catalog. The
  // dashboard catalog is intentionally narrower than the agent/MCP catalogs;
  // using it unconditionally makes valid requests such as source=agent,
  // name=bash appear to be missing.
  let records = getToolDefsForSource(sources.length === 1 ? sources[0] : "dashboard");
  if (req.query.name) records = records.filter(tool => tool.name === req.query.name);
  if (req.query.name && records.length === 0) return res.status(404).json({ ok: false, error: "Tool not found: " + req.query.name });
  const limit = Number.parseInt(req.query.limit || "100", 10);
  records = records.slice(0, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 100);
  const decisions = buildPolicyInspection(records, sources);
  res.json({ total: decisions.length, sources, summary: summarizePolicyInspection(decisions), decisions });
});

app.get("/api/tool-categories", (req, res) => {
  res.json({ categories: getToolCategoriesWithTools("dashboard") });
});

app.get("/api/compute", (req, res) => {
  try {
    compute.initialize();
    res.json({ ok: true, overview: compute.overview() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/compute/workers", (req, res) => {
  try {
    compute.initialize();
    res.json({
      ok: true,
      workers: compute.workerManager.listWorkers(req.query || {}),
      telemetry: compute.workerManager.listWorkerTelemetry(req.query || {}),
      stats: compute.workerManager.getWorkerStats(),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/compute/jobs", (req, res) => {
  try {
    compute.initialize();
    res.json({
      ok: true,
      jobs: compute.jobManager.listJobs({
        status: req.query.status,
        jobType: req.query.jobType || req.query.job_type,
        project: req.query.project,
        workerId: req.query.workerId || req.query.worker_id,
        capability: req.query.capability,
        limit: req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : 50,
      }),
      stats: compute.jobManager.getJobStats(),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/compute/jobs/:jobId", (req, res) => {
  try {
    compute.initialize();
    const job = compute.jobManager.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });
    res.json({ ok: true, job, attempts: compute.jobManager.listAttempts(req.params.jobId), artifacts: compute.jobManager.listArtifacts(req.params.jobId) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

function computeInstallInfo(req, enrollmentToken) {
  const serverUrl = new URL(`${req.protocol}://${req.get("host")}`);
  serverUrl.port = String(MCP_PORT);
  const baseUrl = serverUrl.origin;
  const pkg = (() => {
    try { return require(path.join(__dirname, "..", "package.json")); } catch { return {}; }
  })();
  const token = enrollmentToken || "<enrollment-token>";
  return {
    workerVersion: pkg.version || "dev",
    protocolVersion: "1",
    baseUrl,
    // Each command runs the platform service installer, which performs the full
    // onboarding in one step: enroll (exchange the token for a persistent
    // credential) -> install the OS service (systemd / launchd / winsw) ->
    // start it. The service then auto-starts at boot and processes jobs on
    // demand; a revoked worker exits cleanly and stays stopped. Run these from
    // the extracted Sidekick compute-worker package directory.
    commands: {
      linux: `sudo SERVER_URL=${baseUrl} ENROLL_TOKEN=${token} ./install-linux.sh`,
      macos: `sudo SERVER_URL=${baseUrl} ENROLL_TOKEN=${token} ./install-macos.sh`,
      windows: `.\\install-windows.ps1 -ServerUrl ${baseUrl} -EnrollToken ${token}`,
      // Development checkout (no system service): enroll, then run in the
      // foreground. Use the platform installer above for a managed service.
      source: `node src/compute/worker-agent.js enroll --server ${baseUrl} --token ${token} && node src/compute/worker-agent.js run --server ${baseUrl}`,
    },
    notes: [
      "Run the platform command from the extracted Sidekick compute-worker package directory (the folder containing install-*.{sh,ps1}).",
      "The installer enrolls, installs the OS service, and starts it — no separate start step is needed.",
      "Linux and macOS require root (sudo); Windows requires an elevated PowerShell.",
      "Windows: winsw must be bundled in the package (as sidekick-compute-worker.exe) or pass -WinswUrl <winsw release .exe> to install-windows.ps1.",
      "The 'source' command is for a development checkout and runs in the foreground without installing a service.",
      "Enrollment tokens are single-use and should be pasted only on the worker machine being added.",
    ],
  };
}

app.get("/api/compute/install", (req, res) => {
  try { res.json({ ok: true, install: computeInstallInfo(req) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/compute/enrollment-tokens", (req, res) => {
  const body = req.body || {};
  return governedDashboardMutation(req, res, "compute_nodes", {
    action: "create_token",
    display_name: body.displayName || body.display_name,
    trust_level: body.trustLevel || body.trust_level || "trusted",
    allowed_data_classifications: body.allowedDataClassifications || body.allowed_data_classifications || ["public", "internal", "private"],
    max_concurrent_jobs: Math.min(16, Math.max(1, Number(body.maxConcurrentJobs || body.max_concurrent_jobs || 2))),
    expires_in_ms: Math.min(7 * 24 * 60 * 60 * 1000, Math.max(60 * 1000, Number(body.expiresInMs || body.expires_in_ms || 3600000))),
    ...(body.reEnrollmentOf || body.re_enrollment_of ? { re_enrollment_of: body.reEnrollmentOf || body.re_enrollment_of } : {}),
  }, "compute.enrollment_token.created");
});

app.post("/api/compute/workers/:workerId/:action", (req, res) => {
  const action = req.params.action;
  if (!["disable", "enable", "revoke"].includes(action)) return res.status(404).json({ ok: false, error: "unknown worker action" });
  return governedDashboardMutation(req, res, "compute_nodes", {
    action: action === "revoke" ? "revoke" : "maintenance",
    worker_id: req.params.workerId,
    enable: action === "enable",
    reason: req.body?.reason || "dashboard_revoked",
  }, `compute.worker.${action}`);
});

app.post("/api/compute/jobs/:jobId/:action", (req, res) => {
  const action = req.params.action;
  if (!["cancel", "retry"].includes(action)) return res.status(404).json({ ok: false, error: "unknown job action" });
  return governedDashboardMutation(req, res, "compute_jobs", {
    action,
    job_id: req.params.jobId,
    reason: req.body?.reason || `dashboard_${action}`,
  }, `compute.job.${action}`);
});

app.post("/api/compute/recover", (req, res) => governedDashboardMutation(req, res, "compute_jobs", { action: "recover" }, "compute.jobs.recover"));

registerBlackboxRoutes({ app, blackbox, requireIdentityPermission, blackboxJson, governedDashboardMutation });

registerPredictRoutes({ app, predictEngine, governedDashboardMutation });

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

// Actions that change what code the server will run, or that approve such a
// change. These must be attributable to a real principal for the same reason
// connector registration is (invariant I19): "dashboard" is not a person, and
// promoting or running a self-generated tool is a critical-risk operation.
const EVOLVE_MUTATIONS = new Set(["approve", "reject", "promote", "run", "delete", "retire"]);

function requireAttributedActor(req, res, what) {
  const actor = authenticatedUser(req);
  if (!actor) {
    res.status(403).json({ ok: false, error: `${what} requires an authenticated dashboard user` });
    return null;
  }
  return actor;
}

async function evolveDashboardAction(req, res, action, extra = {}) {
  try {
    let actor = authenticatedUser(req);
    if (EVOLVE_MUTATIONS.has(action)) {
      actor = requireAttributedActor(req, res, "Evolve approval and promotion");
      if (!actor) return;
    }
    auditLog(req, `evolve.${action}`, { id: req.params.id || req.body?.id || null });
    const result = await callDashboardTool("evolve", { action, id: req.params.id || req.body?.id, ...(req.body || {}), ...extra }, dashboardExecutionMetadata(req, actor || "dashboard"));
    res.json({ ok: !result.isError, result: result.content?.[0]?.text || "" });
  } catch (error) {
    logError(req.originalUrl, 500, error, "evolve", req.headers["user-agent"]);
    res.status(500).json({ ok: false, error: error.message });
  }
}

// --- Capabilities (capability packs) ---------------------------------------
//
// Every mutation routes through callDashboardTool("capability", ...), so the
// browser never touches pack state directly: the dispatcher applies policy,
// approval, redaction and audit exactly as it does for an MCP caller. The
// blanket dashboard auth middleware and the Origin/CSRF check above already
// gate these routes.

function capabilityResult(res, result) {
  const text = result && result.content && result.content[0] ? result.content[0].text : "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { ok: !result?.isError, message: text };
  }
  if (result && result.isError) return res.status(400).json({ ok: false, ...payload });
  return res.json({ ok: true, ...payload });
}

// Installing, enabling or upgrading a pack activates executable module code
// inside the server process — the `capability` tool is critical risk for
// exactly that reason. Reads stay open to the dashboard's existing gating;
// mutations must name a real principal, like connector registration does.
const CAPABILITY_MUTATIONS = new Set([
  "install", "configure", "enable", "disable", "upgrade", "uninstall",
]);

async function capabilityAction(req, res, args, auditAction) {
  try {
    let actor = authenticatedUser(req);
    if (CAPABILITY_MUTATIONS.has(args.action)) {
      actor = requireAttributedActor(req, res, "Capability pack installation and lifecycle changes");
      if (!actor) return;
    }
    auditLog(req, `capability.${auditAction}`, { name: args.name || args.path || null });
    const result = await callDashboardTool("capability", args, dashboardExecutionMetadata(req, actor || "dashboard"));
    return capabilityResult(res, result);
  } catch (error) {
    logError(req.originalUrl, 500, error, "capability", req.headers["user-agent"]);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

registerCapabilityRoutes({ app, capabilityAction, capabilityResult, callDashboardTool, dashboardExecutionMetadata, authenticatedUser, logError });

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

registerEvolveRoutes({
  app, evolveDashboardAction, authenticatedUser, dbStore, shapeExecution,
  requireAttributedActor, crypto, callDashboardTool, dashboardExecutionMetadata,
  redactSensitive, auditLog, dynamicTools,
});

registerApprovalRoutes({ app, listApprovals, renderContinuationApprovalPreview, authenticatedUser, auditLog, logError, resolveApproval, requireIdentityPermission });

/**
 * On-demand argument preview for a task-originated approval (ADR §4.4).
 *
 * Previews are no longer persisted, so this is the only way a reviewer can see
 * what they are authorizing. Rendering requires the decryption key at read
 * time and an authenticated principal; a key-less or unauthenticated reader
 * gets metadata and digests only, which is the correct failure direction.
 *
 * The payload is authenticated against `args_digest` before rendering, so a
 * substituted payload reports as tampered rather than being displayed as
 * genuine — the reviewer is the control that catches exactly that.
 */
/**
 * Reconciliation surface (ADR §8.2, T10).
 *
 * These resolve an AMBIGUOUS HIGH-RISK EXECUTION — a step that may or may not
 * have landed — so they are held to a stricter bar than approval:
 *
 *   - they require an AUTHENTICATED HUMAN (I19). No automated actor may resolve
 *     an ambiguity, least of all its own, so an unauthenticated deployment is
 *     refused outright rather than falling back to a marker string.
 *   - `confirm_not_executed` is the most dangerous decision in the system:
 *     asserting an effect did not happen when it did produces exactly the
 *     double-execution the risk gate exists to prevent. It is audited but not
 *     verifiable.
 */
app.get("/api/reconciliations", (req, res) => {
  try {
    const store = require("./approvals/store");
    store.ensureApprovalContinuationSchema();
    const rows = store.listApprovalRows({ status: "reconciliation_required", limit: req.query.limit });
    // Metadata only: no argument or result content. Rendering a preview
    // requires the decryption key and is produced on demand, never persisted
    // (I12).
    res.json({
      ok: true,
      reconciliations: rows.map(r => ({
        approval_id: r.approval_id,
        task_id: r.task_id,
        step_id: r.step_id,
        tool_name: r.tool_name,
        risk: r.risk,
        args_digest: r.args_digest,
        requested_at: r.requested_at,
        updated_at: r.updated_at,
        approver_identity: r.approver_identity,
        attempt_count: r.attempt_count,
        // Whether the payload is still renderable through the on-demand
        // preview. Someone deciding whether an effect landed needs to see the
        // action; if the payload has been discarded they get digests only and
        // should know that rather than meeting a control that always fails.
        args_preview_available: Boolean(r.args_encrypted),
      })),
      // Surfaced so the UI can explain WHY the controls are absent rather than
      // rendering buttons that will 403. Reconciliation requires an
      // authenticated human and fails closed without one (I19).
      can_resolve: Boolean(authenticatedUser(req)),
    });
  } catch (error) {
    logError(req.originalUrl, 500, error, "reconciliations", req.headers["user-agent"]);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/reconciliations/:taskId/resolve", (req, res) => {
  try {
    const reconciledBy = authenticatedUser(req);
    if (!reconciledBy) {
      return res.status(403).json({
        ok: false,
        error: "Reconciliation requires an authenticated human; configure dashboard authentication",
      });
    }
    const decision = String(req.body?.decision || "");
    const { resolveReconciliation } = require("./approvals/continuation");
    let outcome;
    try {
      outcome = resolveReconciliation({ taskId: req.params.taskId, decision, reconciledBy });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    auditLog(req, "approval.reconcile", { task_id: req.params.taskId, decision, reconciled_by: reconciledBy, ok: outcome.ok });
    if (!outcome.ok) return res.status(409).json({ ok: false, error: outcome.code });
    res.json({ ok: true, task_id: outcome.taskId, decision: outcome.decision, state: outcome.checkpointState });
  } catch (error) {
    logError(req.originalUrl, 500, error, "reconciliations", req.headers["user-agent"]);
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

registerMemoryReadRoutes({ app, dbStore, memoryCategory });

/**
 * Memory mutations route through the dispatcher where a tool action exists
 * (memory_manage delete/disable, memory_export, memory_import) so policy,
 * redaction, and audit apply exactly as for MCP callers. Direct dbStore access
 * remains only where no tool action exists (enable, bulk stale expiry), with
 * audit. All failures carry real HTTP status codes — a missing id is 404 and
 * an error is 4xx/5xx, never `{ok:false}` under HTTP 200.
 */
async function dispatchMemoryManage(req, res, args, auditAction) {
  try {
    if (req.authPrincipal && !requireIdentityAdministrator(req, res)) return;
    auditLog(req, auditAction, { id: args.id });
    const result = await callDashboardTool("memory_manage", args,
      dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
    const text = result?.content?.[0]?.text || "";
    if (result?.isError) {
      // The tool reports a missing id in its message text; that is the one
      // signal available without widening the tool contract.
      const httpStatus = /not found/i.test(text) ? 404 : 500;
      return res.status(httpStatus).json({ ok: false, error: text || "memory operation failed" });
    }
    return res.json({ ok: true, message: text });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

app.post("/api/memories/:id/disable", (req, res) =>
  dispatchMemoryManage(req, res, { action: "disable", id: req.params.id }, "memory_disable"));

app.post("/api/memories/:id/enable", (req, res) => {
  // memory_manage has no "enable" action (its "restore" revives deleted or
  // expired records, a different semantic), so this stays on dbStore directly
  // — with audit and honest status codes.
  try {
    if (req.authPrincipal && !requireIdentityAdministrator(req, res)) return;
    const success = dbStore.enableMemory(req.params.id);
    auditLog(req, "memory_enable", { id: req.params.id, ok: success });
    if (!success) {
      return res.status(404).json({ ok: false, error: "Memory not found or not enable-able (deleted/expired memories require restore)" });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete("/api/memories/:id", (req, res) =>
  dispatchMemoryManage(req, res, { action: "delete", id: req.params.id, reason: "dashboard_delete" }, "memory_delete"));

app.post("/api/memories/export", async (req, res) => {
  try {
    const { project, type, include_disabled } = req.body || {};
    const result = await callDashboardTool("memory_export", {
      ...(project ? { project } : {}),
      ...(type ? { type } : {}),
      ...(include_disabled === false ? { include_disabled: false } : {}),
    }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
    const text = result?.content?.[0]?.text || "";
    if (result?.isError) {
      return res.status(500).json({ ok: false, error: text || "export failed" });
    }
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data) return res.status(500).json({ ok: false, error: "export produced an unreadable payload" });
    auditLog(req, "memory_export", { count: data.count, project, type });
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/memories/import", async (req, res) => {
  try {
    const { data, on_conflict, preserve_ids } = req.body || {};
    if (data === undefined || data === null) {
      return res.status(400).json({ ok: false, error: "data required" });
    }
    const result = await callDashboardTool("memory_import", {
      // The tool takes the export payload as a JSON string.
      data: typeof data === "string" ? data : JSON.stringify(data),
      ...(on_conflict ? { on_conflict } : {}),
      ...(preserve_ids === true ? { preserve_ids: true } : {}),
    }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
    const text = result?.content?.[0]?.text || "";
    if (result?.isError) {
      const httpStatus = /invalid json/i.test(text) ? 400 : 500;
      return res.status(httpStatus).json({ ok: false, error: text || "import failed" });
    }
    // Recover the structured counts from the tool's summary line so existing
    // clients keep their imported/updated/skipped fields.
    const counts = text.match(/(\d+) imported, (\d+) updated, (\d+) skipped/);
    const summary = {
      imported: counts ? Number(counts[1]) : undefined,
      updated: counts ? Number(counts[2]) : undefined,
      skipped: counts ? Number(counts[3]) : undefined,
    };
    auditLog(req, "memory_import", summary);
    res.json({ ok: true, ...summary, message: text });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/memories/expire", (req, res) => {
  // Bulk stale expiry has no memory_manage action (`expire` there takes a
  // single id; `process_auto_expirations` is a different sweep), so this stays
  // on dbStore directly — with audit and honest status codes.
  try {
    if (req.authPrincipal && !requireIdentityAdministrator(req, res)) return;
    const { stale_days } = req.body || {};
    if (stale_days !== undefined && (!Number.isFinite(Number(stale_days)) || Number(stale_days) < 0)) {
      return res.status(400).json({ ok: false, error: "stale_days must be a non-negative number" });
    }
    const result = dbStore.expireStaleMemories({ staleDays: stale_days });
    auditLog(req, "memory_expire", { expired: result.expired, stale_days });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function canReadDashboardHandoff(req, handoff) {
  const principal = req.authPrincipal;
  if (!principal?.principal_id || !handoff) return false;
  if (handoff.owner_principal_id === principal.principal_id || handoff.created_by_principal_id === principal.principal_id) return true;
  const roles = Array.isArray(principal.roles) ? principal.roles : [];
  return roles.some(role => ["owner", "administrator"].includes(String(role).toLowerCase()));
}

function requireDashboardHandoff(req, res) {
  const handoff = dbStore.getHandoff(req.params.id);
  if (!handoff || !canReadDashboardHandoff(req, handoff)) {
    res.status(404).json({ ok: false, error: "Handoff not found" });
    return null;
  }
  return handoff;
}

app.get("/api/handoffs", (req, res) => {
  try {
    const handoffs = dbStore.listHandoffs({ project: req.query.project, includeArchived: req.query.include_archived === "true", limit: Math.min(Number(req.query.limit) || 50, 500) });
    res.json({ ok: true, handoffs: handoffs.filter(handoff => canReadDashboardHandoff(req, handoff)) });
  } catch (error) {
    res.json({ ok: false, error: error.message, handoffs: [] });
  }
});

app.get("/api/handoffs/:id/readiness", (req, res) => {
  try {
    if (!requireDashboardHandoff(req, res)) return;
    const readiness = dbStore.getHandoffReadiness(req.params.id, { recipient: req.query.recipient });
    if (readiness.status === "invalid" && readiness.reasons?.includes("handoff not found")) return res.status(404).json({ ok: false, readiness });
    res.json({ ok: true, readiness });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/handoffs/:id/start-here", (req, res) => {
  try {
    if (!requireDashboardHandoff(req, res)) return;
    const projection = dbStore.getHandoffReceiverProjection(req.params.id, { recipient: req.query.recipient });
    if (!projection) return res.status(404).json({ ok: false, error: "Handoff not found" });
    res.json({ ok: true, projection });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/handoffs/:id/preflight", (req, res) => {
  try {
    if (!requireDashboardHandoff(req, res)) return;
    const preflight = dbStore.getHandoffResumePreflight(req.params.id, { recipient: req.query.recipient, simulate: req.query.simulate === "true" });
    if (preflight.status === "invalid") return res.status(404).json({ ok: false, preflight });
    res.json({ ok: true, preflight });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/handoffs/:id/events", (req, res) => {
  try {
    if (!requireDashboardHandoff(req, res)) return;
    res.json({ ok: true, handoff_id: req.params.id, events: dbStore.listHandoffEvents(req.params.id, req.query.limit || 100) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/handoffs/:id", (req, res) => {
  try {
    const handoff = requireDashboardHandoff(req, res);
    if (!handoff) return;
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

registerSyncRoutes({ app, dbStore, auditLog });

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

registerDatabaseRoutes({
  app, dbStore, dataDir: DATA_DIR, path, fs, callDashboardTool,
  dashboardExecutionMetadata, authenticatedUser, requireDashboardTool, auditLog,
});

// Destructive clears report what actually happened. These previously answered
// `{ok: true}` unconditionally after an empty catch, so a permission error, a
// locked database, or a partially-completed multi-step clear was presented to
// the "clear all" confirmation flow as a completed wipe.
function clearConversationFiles() {
  const dir = path.join(DATA_DIR, "conversations");
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    fs.unlinkSync(path.join(dir, file));
    removed++;
  }
  return removed;
}

function respondToClear(req, res, auditEvent, run) {
  try {
    const detail = run() || {};
    auditLog(req, auditEvent, detail);
    res.json({ ok: true, ...detail });
  } catch (error) {
    logError(req.originalUrl, 500, error, auditEvent, req.headers["user-agent"]);
    auditLog(req, auditEvent + ".failed", { error: redactSensitive(String(error.message || error)) });
    res.status(500).json({ ok: false, error: redactSensitive(String(error.message || error)) });
  }
}

function requireDashboardAdministrator(req, res) {
  if (!req.authPrincipal || !requireIdentityAdministrator) return true;
  return requireIdentityAdministrator(req, res);
}

app.delete("/api/logs", (req, res) =>
  requireDashboardAdministrator(req, res) && respondToClear(req, res, "logs.clear", () => { dbStore.clearToolLogs(); return {}; }));

app.delete("/api/kv", (req, res) =>
  requireDashboardAdministrator(req, res) && respondToClear(req, res, "kv.clear", () => { dbStore.clearKV(); return {}; }));

app.delete("/api/conversations", (req, res) =>
  requireDashboardAdministrator(req, res) && respondToClear(req, res, "conversations.clear", () => ({ removed: clearConversationFiles() })));

app.delete("/api/data", (req, res) =>
  requireDashboardAdministrator(req, res) && respondToClear(req, res, "data.clear", () => {
    // Ordered so a failure reports which stage stopped the wipe rather than
    // claiming the whole clear succeeded.
    dbStore.clearToolLogs();
    dbStore.clearKV();
    return { removed: clearConversationFiles() };
  }));

// Error logging endpoint (for frontend errors). Fire-and-forget by design:
// 204 says "received, no body" without asserting the write succeeded — the
// old {ok:true} claimed a persistence result this handler never verifies.
app.post('/api/internal/error-log', (req, res) => {
  try {
    const entry = req.body || {};
    logError(entry.url, entry.status, entry.error, entry.page, entry.userAgent);
  } catch {}
  res.status(204).end();
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

registerAgentProxyRoutes({ app, http, agentPort: AGENT_PORT });

// --- Frontend ---

app.get("/", (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf-8")
    .replace("__VPS_IP__", VPS_IP);
  res.set("Content-Type", "text/html; charset=utf-8").set("Cache-Control", "no-cache").send(html);
});

let dashboardServer = null;
let dashboardShutdown = null;

dashboardServer = app.listen(PORT, BIND_HOST, () => {
  seedKV();
  console.log("Sidekick dashboard listening on http://" + BIND_HOST + ":" + PORT);
});

async function gracefulDashboardShutdown(signal) {
  if (dashboardShutdown) return dashboardShutdown;
  dashboardShutdown = (async () => {
    console.error(`[Dashboard] Received ${signal}; draining HTTP requests`);
    if (dashboardServer) await new Promise(resolve => dashboardServer.close(() => resolve()));
    try { dbStore.closeDatabase(); } catch {}
  })();
  return dashboardShutdown;
}

process.once("SIGTERM", () => gracefulDashboardShutdown("SIGTERM").then(() => process.exit(0)));
process.once("SIGINT", () => gracefulDashboardShutdown("SIGINT").then(() => process.exit(0)));
