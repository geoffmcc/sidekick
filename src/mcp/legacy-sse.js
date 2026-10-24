const { SSEServerTransport } = require("@modelcontextprotocol/server-legacy/sse");
const { sanitizeMcpLogLabel } = require("./log-label");

function reportSseFailure(event) {
  // Keep exception-controlled text out of client responses and routine logs.
  console.error(`[${event}] internal_error`);
}

function registerLegacySseRoutes({ app, sessionManager, createMcpServer }) {
  app.get("/sse", async (req, res) => {
    try {
      const capacity = sessionManager.getSessionCapacity(req.authIdentity || null);
      if (!capacity.allowed) {
        const perIdentity = capacity.scope === "identity";
        return res.status(perIdentity ? 429 : 503).json({
          error: perIdentity ? "MCP session limit reached for this identity; close an unused session and retry" : "MCP server session capacity is full; retry after inactive sessions expire",
          code: "session_capacity_exceeded",
        });
      }
      const authState = { current: req.authIdentity || null };
      const server = createMcpServer(() => authState.current);
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      const metadata = {
        userAgent: req.headers["user-agent"],
        clientInfo: null,
        authIdentity: req.authIdentity || null,
        authState
      };
      if (!sessionManager.registerSession(sessionId, server, transport, metadata)) {
        await server.close?.();
        return res.status(503).json({ error: "MCP server session capacity is full; retry after inactive sessions expire", code: "session_capacity_exceeded" });
      }
      await server.connect(transport);
      console.log(`[SSE] New session: ${sanitizeMcpLogLabel(sessionId)} from ${sanitizeMcpLogLabel(metadata.userAgent, "unknown")}`);
    } catch (e) {
      reportSseFailure("SSE");
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
    }
  });

  app.post("/messages", async (req, res) => {
    try {
      const sessionId = req.query.sessionId;
      if (!sessionId || !sessionManager.hasSession(sessionId)) return res.status(400).json({ error: "Invalid session" });
      const entry = sessionManager.getSession(sessionId);
      if (!sessionManager.authorizeSessionIdentity(sessionId, req.authIdentity || null)) {
        return res.status(403).json({ error: "MCP session belongs to a different authenticated principal", code: "session_identity_mismatch" });
      }
      if (!(entry.transport instanceof SSEServerTransport)) return res.status(400).json({ error: "Not an SSE session" });
      entry.lastAccess = Date.now();
      await entry.transport.handlePostMessage(req, res, req.body);
    } catch (e) {
      reportSseFailure("SSE POST");
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
    }
  });
}

module.exports = { registerLegacySseRoutes };
