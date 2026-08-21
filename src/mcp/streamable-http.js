const { createMcpHandler, isLegacyRequest } = require("@modelcontextprotocol/server");

function createModernMcpHandler(createMcpServer) {
  return createMcpHandler(
    context => createMcpServer(() => context.authInfo || null),
    { legacy: "reject" }
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

function registerStreamableHttpRoutes({ app, sessionManager, createMcpServer, logDebug }) {
  const modernMcpHandler = createModernMcpHandler(createMcpServer);

  function logSession(method, headers, body) {
    const sessionId = headers["mcp-session-id"] || headers["Mcp-Session-Id"] || "none";
    const methodType = body ? (typeof body === "object" ? body.method : "unknown") : "unknown";
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
        if (webRes.body) {
          const reader = webRes.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
        return res.end();
      }

      const { transport, isNew, newSessionId, staleRedirect, replacedStaleSession } = await sessionManager.getTransportForRequest(sessionId, metadata, { allowStalePost: true });
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
      const text = await webRes.text();
      if (text) res.send(text); else res.end();
    } catch (e) {
      console.error("MCP error:", e.message);
      logDebug("MCP_POST_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
      if (!res.headersSent) res.status(500).json({ error: e.message });
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
      const { transport, newSessionId, staleRedirect } = await sessionManager.getTransportForRequest(sessionId, { authIdentity: req.authIdentity || null });
      if (staleRedirect) return sendInvalidSession(res, logDebug, { sessionId, replacementId: newSessionId, message: "MCP session expired. Reconnect and initialize using the mcp-session-id response header." });
      const webReq = new Request("http://127.0.0.1:4097/mcp", { method: "GET", headers: wh });
      const webRes = await transport.handleRequest(webReq);
      res.status(webRes.status);
      copyResponseHeaders(res, webRes);
      if (webRes.body) {
        const reader = webRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(Buffer.from(value));
        }
      } else res.end();
    } catch (e) {
      console.error("MCP GET error:", e.message);
      logDebug("MCP_GET_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
      if (!res.headersSent) res.status(500).json({ error: e.message });
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
      const { transport, newSessionId, staleRedirect } = await sessionManager.getTransportForRequest(sessionId, { authIdentity: req.authIdentity || null });
      if (staleRedirect) return sendInvalidSession(res, logDebug, { sessionId, replacementId: newSessionId, message: "MCP session expired. The previous session is already gone." });
      const webReq = new Request("http://127.0.0.1:4097/mcp", { method: "DELETE", headers: wh });
      const webRes = await transport.handleRequest(webReq);
      if (sessionId && sessionManager.hasSession(sessionId)) {
        sessionManager.deleteSession(sessionId);
        logDebug("SESSION_DELETED", { sessionId });
      }
      res.status(webRes.status);
      copyResponseHeaders(res, webRes);
      const text = await webRes.text();
      if (text) res.send(text); else res.end();
    } catch (e) {
      console.error("MCP DELETE error:", e.message);
      logDebug("MCP_DELETE_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { createModernMcpHandler, registerStreamableHttpRoutes, sendInvalidSession };
