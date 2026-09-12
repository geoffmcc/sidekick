/** Browser-facing Agent relay. The Agent service owns task authorization and execution. */
function registerAgentProxyRoutes({ app, http, agentPort, errorResponse }) {
  function proxyAgent(req, res, method, body) {
    const headers = { "Content-Type": "application/json" };
    if (req.authPrincipal?.principal_id) headers["X-Sidekick-Principal-ID"] = String(req.authPrincipal.principal_id).slice(0, 160);
    if (Array.isArray(req.authPrincipal?.scopes)) headers["X-Sidekick-Principal-Scopes"] = JSON.stringify(req.authPrincipal.scopes.slice(0, 80)).slice(0, 4000);
    if (req.authPrincipal?.delegation_id) headers["X-Sidekick-Delegation-ID"] = String(req.authPrincipal.delegation_id).slice(0, 160);
    if (body) headers["Content-Length"] = Buffer.byteLength(body);
    const upstream = http.request({ hostname: "127.0.0.1", port: agentPort, path: req.originalUrl, method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", error => { if (!res.headersSent) errorResponse(req, res, error, { status: 502, code: "upstream_unavailable", component: "agent_proxy" }); else res.end(); });
    if (body) upstream.write(body);
    upstream.end();
  }
  const relay = (method, withBody = false) => (req, res) => proxyAgent(req, res, method, withBody ? JSON.stringify(req.body || {}) : undefined);
  app.post("/api/agent/run", relay("POST", true));
  app.get("/api/agent/tasks", relay("GET"));
  app.get("/api/agent/tasks/:taskId", relay("GET"));
  app.get("/api/agent/tasks/:taskId/control-room", relay("GET"));
  app.post("/api/agent/tasks/:taskId/plans", relay("POST", true));
  app.post("/api/agent/tasks/:taskId/escalations", relay("POST", true));
  app.post("/api/agent/tasks/:taskId/work-packages", relay("POST", true));
  app.post("/api/agent/tasks/:taskId/work-packages/:packageId/claim", relay("POST", true));
  app.get("/api/agent/tasks/:taskId/workspace-transactions", relay("GET"));
  app.post("/api/agent/tasks/:taskId/workspace-transactions/:transactionId/rollback", relay("POST", true));
  app.post("/api/agent/tasks/:taskId/verification-recipes", relay("POST", true));
  app.post("/api/agent/tasks/:taskId/verification-recipes/:recipeId/run", relay("POST", true));
  app.get("/api/agent/learning-candidates", relay("GET"));
  app.post("/api/agent/learning-candidates", relay("POST", true));
  app.post("/api/agent/learning-candidates/:candidateId/review", (req, res) => { const body = { ...(req.body || {}) }; if (body.state === "active") { const principal = req.authPrincipal?.principal_id; if (!principal) return res.status(403).json({ error: "authenticated operator approval is required" }); body.approved_by = principal; } proxyAgent(req, res, "POST", JSON.stringify(body)); });
  app.post("/api/agent/tasks/:taskId/guidance", relay("POST", true));
  app.post("/api/agent/tasks/:taskId/resume", relay("POST", true));
  app.post("/api/agent/tasks/:taskId/pause", relay("POST", true));
  app.post("/api/agent/tasks/:taskId/act-on", relay("POST", true));
  app.post("/api/agent/run/:taskId/follow-up", relay("POST", true));
  app.post("/api/agent/run/:taskId/cancel", relay("POST", true));
  app.get("/api/agent/stream/:taskId", relay("GET"));
  app.get("/api/agent/history", relay("GET"));
  app.get("/api/agent/session/:rootId", relay("GET"));
  app.get("/api/agent/run/:id", relay("GET"));
}

module.exports = { registerAgentProxyRoutes };
