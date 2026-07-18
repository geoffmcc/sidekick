require("./env");
const express = require("express");
const cors = require("cors");
const { timingSafeCompare } = require("./crypto-utils");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { WebStandardStreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");
const { DATA_DIR, callMcpTool, loadProcedures, syncToolRegistry } = require("./tools");
const { getBuiltinRegistry } = require("./tools/index");
const dynamicTools = require("./dynamic-tools");
const { stripSidekickPrefix } = require("./core/tool-name");
const dbStore = require("./db");
const packageJson = require("../package.json");

const APP_VERSION = packageJson.version || "0.0.0";
const NODE_REQUIREMENT = packageJson.engines?.node || "unspecified";

const API_KEY = process.env.SIDEKICK_API_KEY;
if (!API_KEY || API_KEY === "sk-sidekick-local-dev" || API_KEY === "sk-your-key-here") {
  throw new Error("SIDEKICK_API_KEY must be set to a non-placeholder value");
}
const PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const ALLOWED_IPS = (process.env.SIDEKICK_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);

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

function logDebug(context, data) {
  const ts = new Date().toISOString();
  const prefix = `[MCP-DEBUG ${ts}]`;
  if (typeof data === 'string') {
    console.log(`${prefix} ${context}: ${data}`);
  } else {
    console.log(`${prefix} ${context}:`, JSON.stringify(data, null, 2));
  }
}

// --- Factory: create fresh McpServer + register tools ---

function buildProcedureSchema(parameters) {
  const shape = {};
  for (const [key, def] of Object.entries(parameters || {})) {
    let field;
    if (def.type === "number") {
      field = z.number().describe(def.description || key);
    } else if (def.type === "boolean") {
      field = z.boolean().describe(def.description || key);
    } else {
      field = z.string().describe(def.description || key);
    }
    if (!def.required) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return z.object(shape);
}

function createMcpServer() {
  const server = new McpServer({
    name: "sidekick-mcp-server",
    version: APP_VERSION
  }, {
    capabilities: { tools: {} }
  });

  const builtinRegistry = getBuiltinRegistry();
  for (const descriptor of builtinRegistry.listInDefinitionOrder()) {
    const mcpName = stripSidekickPrefix(descriptor.name);
    server.registerTool(mcpName, {
      description: descriptor.description,
      inputSchema: descriptor.schema
    }, async (args, extra) => {
      return callMcpTool(descriptor.name, args, { requestId: extra?.requestInfo?.requestId });
    });
  }

  const procedures = loadProcedures();
  for (const [procName, proc] of Object.entries(procedures)) {
    const internalName = "sidekick_" + procName;
    if (builtinRegistry.has(internalName)) continue;
    const paramSchema = buildProcedureSchema(proc.parameters);
    const paramNames = Object.keys(proc.parameters || {});
    const paramDesc = paramNames.length > 0 ? ` Parameters: ${paramNames.join(", ")}.` : "";
    server.registerTool(procName, {
      description: `[procedure] ${proc.description}${paramDesc}`,
      inputSchema: paramSchema
    }, async (args, extra) => {
      return callMcpTool("teach", { action: "execute", name: procName, args }, { requestId: extra?.requestInfo?.requestId, generatedProcedure: internalName });
    });
  }

  const dynamicSchemas = dynamicTools.getDynamicToolSchemas();
  for (const def of dynamicTools.getDynamicToolDefs()) {
    if (builtinRegistry.has(def.name)) continue;
    const mcpName = stripSidekickPrefix(def.name);
    server.registerTool(mcpName, {
      description: def.description,
      inputSchema: dynamicSchemas[def.name]
    }, async (args, extra) => {
      return callMcpTool(def.name, args, { requestId: extra?.requestInfo?.requestId, generatedProcedure: def.name, correlationId: def.capabilityId });
    });
  }

  return server;
}

// --- Session management: one McpServer + Transport pair per session ---

const sessions = new Map();
const staleSessionMap = new Map(); // staleId -> { replacementId, createdAt }
const serverStartTime = Date.now();

function generateSessionId() {
  return "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function getTransportForRequest(sessionId, metadata = {}, options = {}) {
  logDebug("getTransportForRequest", { requestedSessionId: sessionId, sessionCount: sessions.size });
  
  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId);
    const age = Date.now() - entry.createdAt;
    const idle = Date.now() - entry.lastAccess;
    entry.lastAccess = Date.now();
    logDebug("REUSE_SESSION", { sessionId, age_ms: age, idle_ms: idle });
    return { transport: entry.transport, isNew: false };
  }

  if (sessionId && !sessions.has(sessionId)) {
    const staleEntry = staleSessionMap.get(sessionId);
    const replacementId = staleEntry?.replacementId;
    if (replacementId && sessions.has(replacementId)) {
      logDebug("STALE_SESSION_KNOWN_REPLACEMENT", { staleSessionId: sessionId, replacementId });
      if (options.allowStalePost) {
        const entry = sessions.get(replacementId);
        entry.lastAccess = Date.now();
        return { transport: entry.transport, isNew: false, newSessionId: replacementId, staleRedirect: false, replacedStaleSession: true };
      }
      return { transport: null, isNew: false, newSessionId: replacementId, staleRedirect: true };
    }

    logDebug("STALE_SESSION_CREATING_REPLACEMENT", { staleSessionId: sessionId, sessionCount: sessions.size });

    const newSessionId = generateSessionId();
    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableJsonResponse: true
    });

    registerSession(newSessionId, server, transport, metadata);
    await server.connect(transport);

    staleSessionMap.set(sessionId, { replacementId: newSessionId, createdAt: Date.now() });
    if (staleSessionMap.size > 100) {
      const firstKey = staleSessionMap.keys().next().value;
      staleSessionMap.delete(firstKey);
    }

    logDebug("CREATED_REPLACEMENT_SESSION", { staleSessionId: sessionId, newSessionId });
    if (options.allowStalePost) {
      return { transport, isNew: true, newSessionId, staleRedirect: false, replacedStaleSession: true };
    }
    return { transport: null, isNew: true, newSessionId, staleRedirect: true };
  }

  const newSessionId = generateSessionId();
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    enableJsonResponse: true
  });

  registerSession(newSessionId, server, transport, metadata);
  await server.connect(transport);

  logDebug("CREATED_NEW_TRANSPORT", { newSessionId });
  return { transport, isNew: true, newSessionId };
}

function sendInvalidSession(res, { sessionId, replacementId = null, message = "MCP session expired or not found. Reconnect and initialize a new session." } = {}) {
  logDebug("INVALID_SESSION_RESPONSE", { sessionId, replacementId });
  res.status(404);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");
  if (replacementId) {
    res.setHeader("mcp-session-id", replacementId);
  }
  res.json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message
    },
    id: null
  });
}

function registerSession(sessionId, server, transport, metadata = {}) {
  logDebug("REGISTER_SESSION", { sessionId, sessionCount: sessions.size + 1, userAgent: metadata.userAgent, clientInfo: metadata.clientInfo });
  sessions.set(sessionId, {
    server,
    transport,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    initialized: false,
    userAgent: metadata.userAgent || null,
    clientInfo: metadata.clientInfo || null
  });
}

function markSessionInitialized(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.initialized = true;
    logDebug("SESSION_INITIALIZED", { sessionId });
  }
}

// Cleanup sessions inactive for more than 1 hour, every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  const evicted = [];
  for (const [id, entry] of sessions) {
    if (entry.lastAccess < cutoff) {
      evicted.push({ sessionId: id, age_ms: Date.now() - entry.createdAt, idle_ms: Date.now() - entry.lastAccess, userAgent: entry.userAgent });
      sessions.delete(id);
    }
  }
  if (evicted.length > 0) {
    logDebug("SESSION_CLEANUP", { evicted, remaining: sessions.size });
  }
}, 600000);

// Cleanup stale session mappings older than 30 minutes, every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 1800000;
  const evicted = [];
  for (const [staleId, entry] of staleSessionMap) {
    if (entry.createdAt < cutoff) {
      evicted.push({ staleSessionId: staleId, replacementId: entry.replacementId, age_ms: Date.now() - entry.createdAt });
      staleSessionMap.delete(staleId);
    }
  }
  if (evicted.length > 0) {
    logDebug("STALE_SESSION_CLEANUP", { evicted, remaining: staleSessionMap.size });
  }
}, 300000);

// --- Express app ---

const app = express();

function getBearerOrQueryToken(req) {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
  }
  return typeof req.query.api_key === "string" ? req.query.api_key : null;
}

if (ALLOWED_IPS.length) {
  app.use((req, res, next) => {
    const ip = req.ip === "::ffff:127.0.0.1" ? "127.0.0.1" : req.ip;
    if (ip === "127.0.0.1" || ip === "::1" || ALLOWED_IPS.some(entry => ipInRange(ip, entry))) {
      return next();
    }
    return res.status(403).json({ error: "Forbidden" });
  });
}

app.get("/health", (req, res) => {
  const uptimeMs = Date.now() - serverStartTime;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

  const includeDetails = timingSafeCompare(getBearerOrQueryToken(req), API_KEY);

  const payload = {
    status: "healthy",
    uptime: uptimeSeconds,
    uptimeHuman: uptimeStr,
    sessions: sessions.size,
    staleMappings: staleSessionMap.size,
    version: APP_VERSION,
    runtime: {
      node: process.version,
      requiredNode: NODE_REQUIREMENT
    },
    timestamp: new Date().toISOString()
  };

  if (includeDetails) {
    payload.sessionDetails = Array.from(sessions.entries()).map(([id, entry]) => ({
      id,
      age: Date.now() - entry.createdAt,
      idle: Date.now() - entry.lastAccess,
      initialized: entry.initialized,
      userAgent: entry.userAgent,
      clientInfo: entry.clientInfo
    }));
  }

  res.json(payload);
});

app.use((req, res, next) => {
  if (isComputeAuthBypassPath(req.path)) return next();
  const token = getBearerOrQueryToken(req);
  if (!timingSafeCompare(token, API_KEY)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.use(express.json({ limit: "1mb" }));

// --- Legacy SSE routes (for clients like opencode) ---

app.get("/sse", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    
    const sessionId = transport.sessionId;
    const metadata = {
      userAgent: req.headers["user-agent"],
      clientInfo: null
    };
    registerSession(sessionId, server, transport, metadata);
    await server.connect(transport);
    
    console.log(`[SSE] New session: ${sessionId} from ${metadata.userAgent || "unknown"}`);
  } catch (e) {
    console.error("[SSE] Error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.post("/messages", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: "Invalid session" });
    }
    
    const entry = sessions.get(sessionId);
    const transport = entry.transport;
    if (!(transport instanceof SSEServerTransport)) {
      return res.status(400).json({ error: "Not an SSE session" });
    }
    
    entry.lastAccess = Date.now();
    await transport.handlePostMessage(req, res, req.body);
  } catch (e) {
    console.error("[SSE POST] Error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// --- Diagnostic logging ---

function logSession(method, headers, body) {
  const sessionId = headers["mcp-session-id"] || headers["Mcp-Session-Id"] || "none";
  const methodType = body ? (typeof body === "object" ? body.method : "unknown") : "unknown";
  console.log(`[MCP ${method}] session=${sessionId} method=${methodType}`);
}

// --- MCP routes ---

app.post("/mcp", async (req, res) => {
  try {
    const body = typeof req.body === "object" ? JSON.stringify(req.body) : req.body || "";
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("POST", wh, req.body);

    const metadata = {
      userAgent: wh["user-agent"],
      clientInfo: req.body?.params?.clientInfo || null
    };
    const { transport, isNew, newSessionId, staleRedirect, replacedStaleSession } = await getTransportForRequest(sessionId, metadata, {
      allowStalePost: true
    });

    if (staleRedirect) {
      return sendInvalidSession(res, {
        sessionId,
        replacementId: newSessionId,
        message: "MCP session expired. Reconnect and initialize using the mcp-session-id response header."
      });
    }

    const activeSessionId = newSessionId || sessionId;
    const activeSession = activeSessionId ? sessions.get(activeSessionId) : null;
    if (activeSession && !activeSession.initialized && req.body?.method !== "initialize") {
      return sendInvalidSession(res, {
        sessionId,
        replacementId: newSessionId,
        message: "MCP session is not initialized. Send initialize before retrying this request."
      });
    }

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "POST",
      headers: replacedStaleSession && newSessionId ? { ...wh, "mcp-session-id": newSessionId } : wh,
      body: body
    });

    const webRes = await transport.handleRequest(webReq, { parsedBody: req.body });

    if (isNew && newSessionId) {
      logDebug("NEW_SESSION_HANDLED", { newSessionId });
    }
    if (req.body?.method === "initialize" && webRes.status >= 200 && webRes.status < 300) {
      markSessionInitialized(newSessionId || sessionId);
    }

    res.status(webRes.status);
    if (replacedStaleSession && newSessionId) {
      res.setHeader("mcp-session-id", newSessionId);
    }
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    const text = await webRes.text();
    if (text) res.send(text);
    else res.end();
  } catch (e) {
    console.error("MCP error:", e.message);
    logDebug("MCP_POST_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get("/mcp", async (req, res) => {
  try {
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("GET", wh, null);

    if (!sessionId) {
      logDebug("GET_WITHOUT_SESSION", { sessionId });
      return sendInvalidSession(res, {
        sessionId,
        message: "GET requires a valid mcp-session-id header."
      });
    }

    const { transport, newSessionId, staleRedirect } = await getTransportForRequest(sessionId);
    if (staleRedirect) {
      return sendInvalidSession(res, {
        sessionId,
        replacementId: newSessionId,
        message: "MCP session expired. Reconnect and initialize using the mcp-session-id response header."
      });
    }

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "GET",
      headers: wh
    });

    const webRes = await transport.handleRequest(webReq);

    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    if (webRes.body) {
      const reader = webRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(Buffer.from(value));
        }
      };
      await pump();
    } else {
      res.end();
    }
  } catch (e) {
    console.error("MCP GET error:", e.message);
    logDebug("MCP_GET_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.delete("/mcp", async (req, res) => {
  try {
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("DELETE", wh, null);

    if (!sessionId) {
      logDebug("DELETE_WITHOUT_SESSION", { sessionId });
      return sendInvalidSession(res, {
        sessionId,
        message: "DELETE requires a valid mcp-session-id header."
      });
    }

    const { transport, newSessionId, staleRedirect } = await getTransportForRequest(sessionId);
    if (staleRedirect) {
      return sendInvalidSession(res, {
        sessionId,
        replacementId: newSessionId,
        message: "MCP session expired. The previous session is already gone."
      });
    }

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "DELETE",
      headers: wh
    });

    const webRes = await transport.handleRequest(webReq);

    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
      logDebug("SESSION_DELETED", { sessionId });
    }

    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    const text = await webRes.text();
    if (text) res.send(text);
    else res.end();
  } catch (e) {
    console.error("MCP DELETE error:", e.message);
    logDebug("MCP_DELETE_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Run pending migrations automatically on startup
try {
  const migrationResult = dbStore.runPendingMigrations();
  if (migrationResult.applied > 0) {
    console.log(`[Migration] Applied ${migrationResult.applied} migration(s):`, migrationResult.migrations.map(m => m.file).join(', '));
  }
} catch (error) {
  console.error('[Migration] Error running migrations:', error.message);
  process.exitCode = 1;
  throw error;
}

// Sync tool registry from code to database on startup
syncToolRegistry();

// Initialize compute subsystem (providers, models, routing, health monitoring)
try {
  const compute = require("./compute");
  compute.initialize();
  console.log("[Compute] Subsystem initialized");
} catch (e) {
  console.error("[Compute] Init failed (non-fatal):", e.message);
}

const compute = require("./compute");
let platformKernelForComputeAudit = null;
try { platformKernelForComputeAudit = require("./platform/kernel"); } catch {}
const computeEnrollmentRateLimit = new Map();

function sendComputeError(res, error, status = 400) {
  const code = error.code || "COMPUTE_ERROR";
  const message = String(error.message || "Compute error").replace(/(wksec_|enroll_)[A-Za-z0-9_-]+/g, "[REDACTED]");
  res.status(status).json({ ok: false, error: message, code });
}

function auditComputeEvent(eventType, { actor = "compute", subjectType, subjectId, payload = {}, severity = "info" } = {}) {
  if (!platformKernelForComputeAudit) return;
  try {
    platformKernelForComputeAudit.appendEvent({
      event_type: eventType,
      source: "compute",
      actor_id: actor,
      subject_type: subjectType,
      subject_id: subjectId,
      severity,
      payload,
      sensitivity: "normal",
      redaction_state: "redacted",
      correlation_id: subjectId || undefined,
    });
  } catch {}
}

function enforceEnrollmentRateLimit(req, res, next) {
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const current = computeEnrollmentRateLimit.get(key) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= 20) return res.status(429).json({ ok: false, error: "enrollment rate limit exceeded" });
  recent.push(now);
  computeEnrollmentRateLimit.set(key, recent);
  next();
}

function requireComputeJsonContent(req, res, next) {
  if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ ok: false, error: "compute protocol requires application/json" });
  }
  next();
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const key = req.headers["x-api-key"] || bearer;
  if (!key || !timingSafeCompare(String(key), API_KEY)) return res.status(401).json({ ok: false, error: "admin authentication required" });
  next();
}

function parseWorkerAuth(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const value = auth.slice(7);
    const idx = value.indexOf(":");
    if (idx > 0) return { workerId: value.slice(0, idx), credential: value.slice(idx + 1) };
  }
  return {
    workerId: req.headers["x-sidekick-worker-id"],
    credential: req.headers["x-sidekick-worker-secret"],
  };
}

function requireWorker(req, res, next) {
  const { workerId, credential } = parseWorkerAuth(req);
  const worker = compute.workerManager.authenticateWorker(workerId, credential);
  if (!worker) return res.status(401).json({ ok: false, error: "worker authentication required" });
  req.computeWorker = worker;
  next();
}

function isComputeAuthBypassPath(pathname) {
  if (pathname === "/compute/enrollment/exchange" || pathname === "/compute/enroll") return true;
  if (pathname.startsWith("/compute/worker/")) return true;
  const legacyWorkerPaths = [
    "/compute/heartbeat",
    "/compute/capabilities",
    "/compute/credentials/rotate",
    "/compute/jobs/claim",
  ];
  if (legacyWorkerPaths.includes(pathname)) return true;
  return /^\/compute\/jobs\/[^/]+\/(start|renew|progress|complete|fail)$/.test(pathname)
    || /^\/compute\/jobs\/[^/]+\/cancellation(\/ack)?$/.test(pathname)
    || /^\/compute\/jobs\/[^/]+\/artifacts\/(upload|[^/]+\/finalize)$/.test(pathname);
}

function createEnrollmentTokenHandler(req, res) {
  try {
    const body = req.body || {};
    const token = compute.workerManager.createEnrollmentToken({
      displayName: body.displayName || body.display_name,
      trustLevel: body.trustLevel || body.trust_level || "trusted",
      allowedDataClassifications: body.allowedDataClassifications || body.allowed_data_classifications || ["public", "internal", "private"],
      maxConcurrentJobs: body.maxConcurrentJobs || body.max_concurrent_jobs || 2,
      expiresInMs: body.expiresInMs || body.expires_in_ms || 3600000,
      createdBy: "admin-http",
      reEnrollmentOf: body.reEnrollmentOf || body.re_enrollment_of || null,
    });
    auditComputeEvent("compute.enrollment_token.created", { actor: "admin-http", subjectType: "compute_enrollment_token", subjectId: token.tokenId, payload: { display_name: body.displayName || body.display_name || null, re_enrollment_of: token.reEnrollmentOf || null } });
    res.json({ ok: true, ...token, message: "Token created. The token value is returned only once." });
  } catch (e) { sendComputeError(res, e, 400); }
}

function enrollWorkerHandler(req, res) {
  try {
    const { token, nodeId, displayName, platform, architecture, cpuInfo, memoryBytes, accelerators, providers, executors, workerVersion, publicKey, protocolVersion } = req.body || {};
    if (!token || !nodeId || !displayName || !platform) {
      return res.status(400).json({ error: "token, nodeId, displayName, and platform are required" });
    }
    if (protocolVersion && String(protocolVersion) !== "1") return res.status(426).json({ ok: false, error: "unsupported worker protocol version", supported: ["1"] });
    const enrolled = compute.workerManager.enrollWorker({
      nodeId, displayName, platform, architecture, cpuInfo, memoryBytes,
      accelerators, providers, executors,
      modelInventory: req.body?.modelInventory || req.body?.model_inventory,
      limits: req.body?.limits,
      health: req.body?.health || req.body?.backendHealth || req.body?.backend_health,
      workerVersion, publicKey, enrollmentToken: token, protocolVersion,
    });
    auditComputeEvent(enrolled.reEnrolled ? "compute.worker.re_enrolled" : "compute.worker.enrolled", { actor: enrolled.worker.workerId, subjectType: "compute_worker", subjectId: enrolled.worker.workerId, payload: { node_id: nodeId, protocol_version: protocolVersion || "1", re_enrolled: !!enrolled.reEnrolled, replaced_worker_id: enrolled.replacedWorkerId || null }, severity: enrolled.reEnrolled ? "warning" : "info" });
    res.json({ ok: true, worker: enrolled.worker, credential: enrolled.credential, credentialType: "worker-bearer-v1", reEnrolled: !!enrolled.reEnrolled });
  } catch (e) {
    sendComputeError(res, e, 400);
  }
}

function heartbeatHandler(req, res) {
  try {
    const { utilization, currentJobs, providers, executors, accelerators, workerVersion } = req.body || {};
    const modelInventory = req.body?.modelInventory || req.body?.model_inventory;
    const limits = req.body?.limits;
    const health = req.body?.health || req.body?.backendHealth || req.body?.backend_health;
    if (providers || executors || accelerators || workerVersion || modelInventory || limits || health) {
      compute.workerManager.updateWorker(req.computeWorker.workerId, { providers, executors, accelerators, workerVersion, modelInventory, limits, health });
    }
    const worker = compute.workerManager.heartbeat(req.computeWorker.workerId, { utilization, currentJobs });
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    res.json({ ok: true, worker });
  } catch (e) {
    sendComputeError(res, e, 400);
  }
}

function disconnectHandler(req, res) {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : "graceful";
    const worker = compute.workerManager.disconnectWorker(req.computeWorker.workerId, reason);
    if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.disconnected", { actor: req.computeWorker.workerId, subjectType: "compute_worker", subjectId: req.computeWorker.workerId, payload: { reason } });
    res.json({ ok: true, worker });
  } catch (e) {
    sendComputeError(res, e, 400);
  }
}

function capabilitiesHandler(req, res) {
  try {
    const { providers, executors, accelerators, maxConcurrentJobs, workerVersion } = req.body || {};
    const worker = compute.workerManager.updateWorker(req.computeWorker.workerId, {
      providers,
      executors,
      accelerators,
      maxConcurrentJobs,
      workerVersion,
      modelInventory: req.body?.modelInventory || req.body?.model_inventory,
      limits: req.body?.limits,
      health: req.body?.health || req.body?.backendHealth || req.body?.backend_health,
    });
    res.json({ ok: true, worker });
  } catch (e) { sendComputeError(res, e, 400); }
}

function rotateCredentialHandler(req, res) {
  try {
    const result = compute.workerManager.rotateCredential(req.computeWorker.workerId);
    if (!result) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.credential_rotated", { actor: req.computeWorker.workerId, subjectType: "compute_worker", subjectId: req.computeWorker.workerId });
    res.json({ ok: true, worker: result.worker, credential: result.credential, credentialType: "worker-bearer-v1" });
  } catch (e) { sendComputeError(res, e, 400); }
}

function createJobHandler(req, res) {
  try {
    const body = req.body || {};
    if (!body.jobType && !body.job_type) return res.status(400).json({ ok: false, error: "jobType is required" });
    const job = compute.jobManager.createJob({
      jobType: body.jobType || body.job_type,
      capability: body.capability || body.jobType || body.job_type,
      source: "http",
      project: body.project,
      taskId: body.taskId || body.task_id,
      sessionId: body.sessionId || body.session_id,
      requestingActor: "admin",
      dataClassification: body.dataClassification || body.data_classification || "private",
      protocolVersion: body.protocolVersion || body.protocol_version || "1",
      capabilityRequirements: body.capabilityRequirements || body.capability_requirements || {},
      routingPreferences: body.routingPreferences || body.routing_preferences || {},
      retryPolicy: body.retryPolicy || body.retry_policy || {},
      resourceRequirements: body.resourceRequirements || body.resource_requirements || {},
      artifactExpectations: body.artifactExpectations || body.artifact_expectations || [],
      outputLimits: body.outputLimits || body.output_limits || {},
      requestPayload: body.requestPayload || body.request_payload || {},
      priority: body.priority,
      expiresAt: body.expiresAt || body.expires_at,
      maxAttempts: body.maxAttempts || body.max_attempts || 3,
      timeoutMs: body.timeoutMs || body.timeout_ms,
      idempotencyKey: body.idempotencyKey || body.idempotency_key,
    });
    res.json({ ok: true, job });
  } catch (e) { sendComputeError(res, e, 400); }
}

function listJobsHandler(req, res) {
  try {
    const jobs = compute.jobManager.listJobs({
      status: req.query?.status,
      jobType: req.query?.jobType || req.query?.job_type,
      project: req.query?.project,
      providerId: req.query?.providerId || req.query?.provider_id,
      workerId: req.query?.workerId || req.query?.worker_id,
      capability: req.query?.capability,
      limit: req.query?.limit ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : 50,
    });
    res.json({ ok: true, jobs, stats: compute.jobManager.getJobStats() });
  } catch (e) { sendComputeError(res, e, 400); }
}

function getJobHandler(req, res) {
  const job = compute.jobManager.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "job not found" });
  res.json({ ok: true, job, attempts: compute.jobManager.listAttempts(req.params.jobId), artifacts: compute.jobManager.listArtifacts(req.params.jobId) });
}

function cancelJobHandler(req, res) {
  try { const job = compute.jobManager.cancelJob(req.params.jobId, { actor: "admin", reason: req.body?.reason || "cancelled" }); auditComputeEvent("compute.job.cancelled", { actor: "admin", subjectType: "compute_job", subjectId: req.params.jobId, payload: { reason: req.body?.reason || "cancelled" }, severity: "warning" }); res.json({ ok: true, job }); }
  catch (e) { sendComputeError(res, e, 400); }
}

function claimJobHandler(req, res) {
  try {
    const claimed = compute.jobManager.claimNextJob(req.computeWorker, { leaseDurationMs: req.body?.leaseDurationMs || req.body?.lease_duration_ms || 300000 });
    res.json({ ok: true, claimed: !!claimed, ...(claimed || {}) });
  } catch (e) { sendComputeError(res, e, 400); }
}

function startJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.startLeasedJob(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function renewJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.renewLease(req.params.jobId, req.body?.leaseId || req.body?.lease_id, req.body?.leaseDurationMs || req.body?.lease_duration_ms || 300000) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function progressJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.updateProgress(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body || {}) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function cancellationStatusHandler(req, res) {
  try { res.json({ ok: true, cancellation: compute.jobManager.getCancellationStatus(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id || req.query?.leaseId || req.query?.lease_id) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function cancellationAckHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.acknowledgeCancellation(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function completeJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.completeJob(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body || {}) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function uploadArtifactHandler(req, res) {
  try {
    const artifact = compute.jobManager.uploadArtifact(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body || {});
    res.json({ ok: true, artifact });
  } catch (e) { sendComputeError(res, e, 409); }
}

function finalizeArtifactHandler(req, res) {
  try {
    const artifact = compute.jobManager.finalizeArtifact(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.params.artifactId, req.body || {});
    res.json({ ok: true, artifact });
  } catch (e) { sendComputeError(res, e, 409); }
}

function failJobHandler(req, res) {
  try { res.json({ ok: true, job: compute.jobManager.failJob(req.params.jobId, req.computeWorker.workerId, req.body?.leaseId || req.body?.lease_id, req.body || {}) }); }
  catch (e) { sendComputeError(res, e, 409); }
}

function recoverJobsHandler(req, res) {
  try { res.json({ ok: true, recovered: compute.jobManager.recoverExpiredLeases() }); }
  catch (e) { sendComputeError(res, e, 500); }
}

function retryJobHandler(req, res) {
  try { const job = compute.jobManager.retryJob(req.params.jobId, { actor: "admin", reason: req.body?.reason || "retry_requested" }); auditComputeEvent("compute.job.retry_requested", { actor: "admin", subjectType: "compute_job", subjectId: req.params.jobId, payload: { reason: req.body?.reason || "retry_requested" } }); res.json({ ok: true, job }); }
  catch (e) { sendComputeError(res, e, 400); }
}

function listWorkersHandler(req, res) {
  try { res.json({ ok: true, workers: compute.workerManager.listWorkers(req.query || {}) }); }
  catch (e) { sendComputeError(res, e, 400); }
}

function getWorkerHandler(req, res) {
  const worker = compute.workerManager.getWorker(req.params.workerId);
  if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
  res.json({ ok: true, worker });
}

function disableWorkerHandler(req, res) {
  try {
    const worker = compute.workerManager.updateWorker(req.params.workerId, { adminState: "maintenance" });
    if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.disabled", { actor: "admin", subjectType: "compute_worker", subjectId: req.params.workerId, payload: { reason: req.body?.reason || null }, severity: "warning" });
    res.json({ ok: true, worker });
  } catch (e) { sendComputeError(res, e, 400); }
}

function enableWorkerHandler(req, res) {
  try {
    const worker = compute.workerManager.updateWorker(req.params.workerId, { adminState: "enabled" });
    if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.enabled", { actor: "admin", subjectType: "compute_worker", subjectId: req.params.workerId, payload: { reason: req.body?.reason || null } });
    res.json({ ok: true, worker });
  } catch (e) { sendComputeError(res, e, 400); }
}

function revokeWorkerHandler(req, res) {
  try {
    const worker = compute.workerManager.revokeWorker(req.params.workerId, req.body?.reason || "admin_revoked");
    if (!worker) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.revoked", { actor: "admin", subjectType: "compute_worker", subjectId: req.params.workerId, payload: { reason: req.body?.reason || "admin_revoked" }, severity: "warning" });
    res.json({ ok: true, worker });
  } catch (e) { sendComputeError(res, e, 400); }
}

function adminRotateWorkerCredentialHandler(req, res) {
  try {
    const result = compute.workerManager.rotateCredential(req.params.workerId);
    if (!result) return res.status(404).json({ ok: false, error: "worker not found" });
    auditComputeEvent("compute.worker.credential_rotated", { actor: "admin", subjectType: "compute_worker", subjectId: req.params.workerId });
    res.json({ ok: true, worker: result.worker, credential: result.credential, credentialType: "worker-bearer-v1" });
  } catch (e) { sendComputeError(res, e, 400); }
}

function computeHealthHandler(req, res) {
  try {
    res.json({ ok: true, overview: compute.overview() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Canonical compute route groups. Enrollment exchange is public but validates a one-time token;
// worker routes require scoped worker credentials; admin routes require the Sidekick API key.
app.use("/compute", requireComputeJsonContent);
const computeEnrollmentRouter = express.Router();
computeEnrollmentRouter.post("/tokens", express.json({ limit: "16kb" }), requireAdmin, createEnrollmentTokenHandler);
computeEnrollmentRouter.post("/exchange", express.json({ limit: "64kb" }), enforceEnrollmentRateLimit, enrollWorkerHandler);
app.use("/compute/enrollment", computeEnrollmentRouter);

const computeWorkerRouter = express.Router();
computeWorkerRouter.use(requireWorker);
computeWorkerRouter.post("/heartbeat", express.json({ limit: "32kb" }), heartbeatHandler);
computeWorkerRouter.post("/disconnect", express.json({ limit: "8kb" }), disconnectHandler);
computeWorkerRouter.post("/capabilities", express.json({ limit: "64kb" }), capabilitiesHandler);
computeWorkerRouter.post("/credentials/rotate", express.json({ limit: "8kb" }), rotateCredentialHandler);
computeWorkerRouter.post("/jobs/claim", express.json({ limit: "16kb" }), claimJobHandler);
computeWorkerRouter.post("/jobs/:jobId/start", express.json({ limit: "16kb" }), startJobHandler);
computeWorkerRouter.post("/jobs/:jobId/renew", express.json({ limit: "16kb" }), renewJobHandler);
computeWorkerRouter.post("/jobs/:jobId/progress", express.json({ limit: "16kb" }), progressJobHandler);
computeWorkerRouter.post("/jobs/:jobId/cancellation", express.json({ limit: "16kb" }), cancellationStatusHandler);
computeWorkerRouter.post("/jobs/:jobId/cancellation/ack", express.json({ limit: "16kb" }), cancellationAckHandler);
computeWorkerRouter.post("/jobs/:jobId/artifacts/upload", express.json({ limit: "512kb" }), uploadArtifactHandler);
computeWorkerRouter.post("/jobs/:jobId/artifacts/:artifactId/finalize", express.json({ limit: "64kb" }), finalizeArtifactHandler);
computeWorkerRouter.post("/jobs/:jobId/complete", express.json({ limit: "512kb" }), completeJobHandler);
computeWorkerRouter.post("/jobs/:jobId/fail", express.json({ limit: "64kb" }), failJobHandler);
app.use("/compute/worker", computeWorkerRouter);

const computeAdminRouter = express.Router();
computeAdminRouter.use(requireAdmin);
computeAdminRouter.get("/workers", listWorkersHandler);
computeAdminRouter.get("/workers/:workerId", getWorkerHandler);
computeAdminRouter.post("/workers/:workerId/disable", express.json({ limit: "8kb" }), disableWorkerHandler);
computeAdminRouter.post("/workers/:workerId/enable", express.json({ limit: "8kb" }), enableWorkerHandler);
computeAdminRouter.post("/workers/:workerId/revoke", express.json({ limit: "8kb" }), revokeWorkerHandler);
computeAdminRouter.post("/workers/:workerId/credentials/rotate", express.json({ limit: "8kb" }), adminRotateWorkerCredentialHandler);
computeAdminRouter.post("/jobs", express.json({ limit: "256kb" }), createJobHandler);
computeAdminRouter.get("/jobs", listJobsHandler);
computeAdminRouter.get("/jobs/:jobId", getJobHandler);
computeAdminRouter.post("/jobs/:jobId/cancel", express.json({ limit: "8kb" }), cancelJobHandler);
computeAdminRouter.post("/jobs/:jobId/retry", express.json({ limit: "8kb" }), retryJobHandler);
computeAdminRouter.post("/recover", express.json({ limit: "8kb" }), recoverJobsHandler);
computeAdminRouter.get("/health", computeHealthHandler);
app.use("/compute/admin", computeAdminRouter);

// Compatibility aliases for the initial compute HTTP protocol. These remain explicitly authenticated
// and are covered by the narrow global-auth bypass above only where worker/enrollment credentials differ.
app.post("/compute/enrollment-tokens", express.json({ limit: "16kb" }), requireAdmin, createEnrollmentTokenHandler);
app.post("/compute/enroll", express.json({ limit: "64kb" }), enforceEnrollmentRateLimit, enrollWorkerHandler);
app.post("/compute/heartbeat", express.json({ limit: "32kb" }), requireWorker, heartbeatHandler);
app.post("/compute/capabilities", express.json({ limit: "64kb" }), requireWorker, capabilitiesHandler);
app.post("/compute/credentials/rotate", express.json({ limit: "8kb" }), requireWorker, rotateCredentialHandler);
app.post("/compute/jobs", express.json({ limit: "256kb" }), requireAdmin, createJobHandler);
app.get("/compute/jobs", requireAdmin, listJobsHandler);
app.get("/compute/jobs/:jobId", requireAdmin, getJobHandler);
app.post("/compute/jobs/:jobId/cancel", express.json({ limit: "8kb" }), requireAdmin, cancelJobHandler);
app.post("/compute/jobs/claim", express.json({ limit: "16kb" }), requireWorker, claimJobHandler);
app.post("/compute/jobs/:jobId/start", express.json({ limit: "16kb" }), requireWorker, startJobHandler);
app.post("/compute/jobs/:jobId/renew", express.json({ limit: "16kb" }), requireWorker, renewJobHandler);
app.post("/compute/jobs/:jobId/progress", express.json({ limit: "16kb" }), requireWorker, progressJobHandler);
app.post("/compute/jobs/:jobId/cancellation", express.json({ limit: "16kb" }), requireWorker, cancellationStatusHandler);
app.post("/compute/jobs/:jobId/cancellation/ack", express.json({ limit: "16kb" }), requireWorker, cancellationAckHandler);
app.post("/compute/jobs/:jobId/artifacts/upload", express.json({ limit: "512kb" }), requireWorker, uploadArtifactHandler);
app.post("/compute/jobs/:jobId/artifacts/:artifactId/finalize", express.json({ limit: "64kb" }), requireWorker, finalizeArtifactHandler);
app.post("/compute/jobs/:jobId/complete", express.json({ limit: "512kb" }), requireWorker, completeJobHandler);
app.post("/compute/jobs/:jobId/fail", express.json({ limit: "64kb" }), requireWorker, failJobHandler);
app.post("/compute/recover", express.json({ limit: "8kb" }), requireAdmin, recoverJobsHandler);
app.get("/compute/health", requireAdmin, computeHealthHandler);

app.listen(PORT, "0.0.0.0", () => {
  console.log("Sidekick MCP server listening on port " + PORT);
  console.log("MCP endpoint: http://0.0.0.0:" + PORT + "/mcp");
  console.log("Data dir: " + DATA_DIR);
});
