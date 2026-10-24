const { createMcpHandler, isLegacyRequest } = require("@modelcontextprotocol/server");
const { MAX_MCP_REQUEST_BODY_BYTES } = require("./limits");

function createModernMcpHandler(createMcpServer) {
  return createMcpHandler(
    context => createMcpServer(() => context.authInfo || null),
    { legacy: "reject", maxRequestBodySize: MAX_MCP_REQUEST_BODY_BYTES }
  );
}

function sendInvalidSession(res, logDebug, { sessionId, replacementId = null, message = "MCP session expired or not found. Reconnect and initialize a new session." } = {}) {
  logDebug("INVALID_SESSION_RESPONSE", { sessionId, replacementId });
  res.status(404);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");
  if (replacementId) res.setHeader("mcp-session-id", replacementId);
  res.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

function headersObject(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
  }
  return headers;
}

function copyResponseHeaders(res, webRes) {
  webRes.headers.forEach((value, key) => {
    if (key !== "content-encoding" && key !== "content-length") res.setHeader(key, value);
  });
}

function reportRouteFailure(logDebug, event, sessionId) {
  // Exception messages and stacks can contain credentials, request data, or
  // local paths. Keep the client response and routine logs independent of
  // exception-controlled text; detailed diagnostics belong in a separately
  // protected operator channel.
  const safeSessionId = typeof sessionId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)
    ? sessionId
    : null;
  try { logDebug(event, { error: "internal_error", sessionId: safeSessionId }); } catch {}
}

function waitForDrainOrClose(res, isDisconnected) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
      res.removeListener("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    if (isDisconnected()) { cleanup(); resolve(); }
  });
}

async function relayResponseBody(body, res) {
  const reader = body?.getReader?.();
  if (!reader) {
    res.end();
    return;
  }

  let disconnected = false;
  const onClose = () => {
    if (res.writableEnded) return;
    disconnected = true;
    reader.cancel().catch(() => {});
  };
  res.once("close", onClose);

  try {
    while (!disconnected) {
      const { done, value } = await reader.read();
      if (done) break;
      if (disconnected) return;
      if (!res.write(Buffer.from(value))) {
        await waitForDrainOrClose(res, () => disconnected);
      }
    }
    if (!disconnected) res.end();
  } catch (error) {
    if (!disconnected) throw error;
  } finally {
    res.removeListener("close", onClose);
    reader.releaseLock?.();
  }
}

function registerStreamableHttpRoutes({ app, sessionManager, createMcpServer, logDebug }) {
  const modernMcpHandler = createModernMcpHandler(createMcpServer);

  function logSession(method, headers, body) {
    const rawSessionId = headers["mcp-session-id"] || headers["Mcp-Session-Id"] || "none";
    const rawMethod = body && typeof body === "object" ? body.method : "unknown";
    const safeLabel = value => typeof value === "string"
      ? value.replace(/[^\x20-\x7E]/g, "?").slice(0, 128)
      : "invalid";
    const sessionId = safeLabel(rawSessionId);
    const methodType = safeLabel(rawMethod);
    console.log(`[MCP ${method}] session=${sessionId} method=${methodType}`);
  }

  app.post("/mcp", async (req, res) => {
    try {
      const body = typeof req.body === "object" ? JSON.stringify(req.body) : req.body || "";
      const wh = headersObject(req);
      const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
      logSession("POST", wh, req.body);
      const metadata = { userAgent: wh["user-agent"], clientInfo: req.body?.params?.clientInfo || null, authIdentity: req.authIdentity || null };
      const webReq = new Request("http://127.0.0.1:4097/mcp", { method: "POST", headers: wh, body });

      if (!(await isLegacyRequest(webReq, req.body))) {
        const webRes = await modernMcpHandler.fetch(webReq, { authInfo: req.authIdentity || undefined, parsedBody: req.body });
        res.status(webRes.status);
        copyResponseHeaders(res, webRes);
        await relayResponseBody(webRes.body, res);
        return;
      }

      const { transport, isNew, newSessionId, staleRedirect, replacedStaleSession, identityMismatch, capacityExceeded, capacityScope } = await sessionManager.getTransportForRequest(sessionId, metadata, { allowStalePost: true });
      if (identityMismatch) {
        return res.status(403).json({ error: "MCP session belongs to a different authenticated principal", code: "session_identity_mismatch" });
      }
      if (capacityExceeded) {
        const perIdentity = capacityScope === "identity";
        return res.status(perIdentity ? 429 : 503).json({
          error: perIdentity ? "MCP session limit reached for this identity; close an unused session and retry" : "MCP server session capacity is full; retry after inactive sessions expire",
          code: "session_capacity_exceeded",
        });
      }
      if (staleRedirect) {
        return sendInvalidSession(res, logDebug, { sessionId, replacementId: newSessionId, message: "MCP session expired. Reconnect and initialize using the mcp-session-id response header." });
      }
      const activeSessionId = newSessionId || sessionId;
      const activeSession = activeSessionId ? sessionManager.getSession(activeSessionId) : null;
      if (activeSession && !activeSession.initialized && req.body?.method !== "initialize") {
        return sendInvalidSession(res, logDebug, { sessionId, replacementId: newSessionId, message: "MCP session is not initialized. Send initialize before retrying this request." });
      }
      const legacyWebReq = new Request("http://127.0.0.1:4097/mcp", {
        method: "POST",
        headers: replacedStaleSession && newSessionId ? { ...wh, "mcp-session-id": newSessionId } : wh,
        body
      });
      const webRes = await transport.handleRequest(legacyWebReq, { parsedBody: req.body });
      if (isNew && newSessionId) logDebug("NEW_SESSION_HANDLED", { newSessionId });
      if (req.body?.method === "initialize" && webRes.status >= 200 && webRes.status < 300) sessionManager.markSessionInitialized(newSessionId || sessionId);
      res.status(webRes.status);
      if (replacedStaleSession && newSessionId) res.setHeader("mcp-session-id", newSessionId);
      copyResponseHeaders(res, webRes);
      await relayResponseBody(webRes.body, res);
    } catch (e) {
      reportRouteFailure(logDebug, "MCP_POST_ERROR", req.headers["mcp-session-id"]);
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
      else res.destroy(e);
    }
  });

  app.get("/mcp", async (req, res) => {
    try {
      const wh = headersObject(req);
      const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
      logSession("GET", wh, null);
      if (!sessionId) {
        logDebug("GET_WITHOUT_SESSION", { sessionId });
        return sendInvalidSession(res, logDebug, { sessionId, message: "GET requires a valid mcp-session-id header." });
      }
      const { transport, newSessionId, staleRedirect, identityMismatch } = await sessionManager.getTransportForRequest(sessionId, { authIdentity: req.authIdentity || null });
      if (identityMismatch) {
        return res.status(403).json({ error: "MCP session belongs to a different authenticated principal", code: "session_identity_mismatch" });
      }
      if (staleRedirect) return sendInvalidSession(res, logDebug, { sessionId, replacementId: newSessionId, message: "MCP session expired. Reconnect and initialize using the mcp-session-id response header." });
      const webReq = new Request("http://127.0.0.1:4097/mcp", { method: "GET", headers: wh });
      const webRes = await transport.handleRequest(webReq);
      res.status(webRes.status);
      copyResponseHeaders(res, webRes);
      await relayResponseBody(webRes.body, res);
    } catch (e) {
      reportRouteFailure(logDebug, "MCP_GET_ERROR", req.headers["mcp-session-id"]);
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
      else res.destroy(e);
    }
  });

  app.delete("/mcp", async (req, res) => {
    try {
      const wh = headersObject(req);
      const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
      logSession("DELETE", wh, null);
      if (!sessionId) {
        logDebug("DELETE_WITHOUT_SESSION", { sessionId });
        return sendInvalidSession(res, logDebug, { sessionId, message: "DELETE requires a valid mcp-session-id header." });
      }
      const { transport, newSessionId, staleRedirect, identityMismatch } = await sessionManager.getTransportForRequest(sessionId, { authIdentity: req.authIdentity || null });
      if (identityMismatch) {
        return res.status(403).json({ error: "MCP session belongs to a different authenticated principal", code: "session_identity_mismatch" });
      }
      if (staleRedirect) return sendInvalidSession(res, logDebug, { sessionId, replacementId: newSessionId, message: "MCP session expired. The previous session is already gone." });
      const webReq = new Request("http://127.0.0.1:4097/mcp", { method: "DELETE", headers: wh });
      const webRes = await transport.handleRequest(webReq);
      if (sessionId && sessionManager.hasSession(sessionId)) {
        sessionManager.deleteSession(sessionId);
        logDebug("SESSION_DELETED", { sessionId });
      }
      res.status(webRes.status);
      copyResponseHeaders(res, webRes);
      await relayResponseBody(webRes.body, res);
    } catch (e) {
      reportRouteFailure(logDebug, "MCP_DELETE_ERROR", req.headers["mcp-session-id"]);
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
      else res.destroy(e);
    }
  });
}

module.exports = { createModernMcpHandler, registerStreamableHttpRoutes, sendInvalidSession, relayResponseBody };
