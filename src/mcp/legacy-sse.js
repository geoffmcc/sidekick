const { SSEServerTransport } = require("@modelcontextprotocol/server-legacy/sse");

function registerLegacySseRoutes({ app, sessionManager, createMcpServer }) {
  app.get("/sse", async (req, res) => {
    try {
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
      sessionManager.registerSession(sessionId, server, transport, metadata);
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
      if (!sessionId || !sessionManager.hasSession(sessionId)) return res.status(400).json({ error: "Invalid session" });
      const entry = sessionManager.getSession(sessionId);
      if (entry.authState) entry.authState.current = req.authIdentity || null;
      if (!(entry.transport instanceof SSEServerTransport)) return res.status(400).json({ error: "Not an SSE session" });
      entry.lastAccess = Date.now();
      await entry.transport.handlePostMessage(req, res, req.body);
    } catch (e) {
      console.error("[SSE POST] Error:", e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerLegacySseRoutes };
