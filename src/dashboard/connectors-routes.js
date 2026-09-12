/**
 * Connector dashboard routes.
 *
 * Route registration is kept separate from the dashboard bootstrap so the
 * connector API can evolve without enlarging the dashboard process module.
 */
function registerConnectorRoutes({
  app,
  platformKernel,
  probeConnector,
  authenticatedUser,
  startDashboardExecution,
  finishDashboardExecution,
  auditLog,
  errorResponse,
}) {
  app.get("/api/connectors", (req, res) => {
    try {
      const connectors = platformKernel.listConnectors({
        state: req.query.state,
        type: req.query.type,
        limit: req.query.limit,
      });
      res.json({
        ok: true,
        connectors,
        total: connectors.length,
        summary: {
          healthy: connectors.filter(connector => connector.state === "healthy").length,
          issues: connectors.filter(connector => connector.state === "error").length,
        },
      });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "connectors" });
    }
  });

  app.post("/api/connectors", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor) return res.status(403).json({ ok: false, error: "Connector operations require an authenticated dashboard user" });
    let execution = null;
    try {
      execution = startDashboardExecution(req, "connector.register");
      const connector = platformKernel.registerConnector({ ...req.body, source: "dashboard", actor_id: actor });
      finishDashboardExecution(execution, "completed", { result_status: "success", result_summary: `connector ${connector.name} registered` });
      auditLog(req, "connector.register", { connector_id: connector.connector_id, name: connector.name, type: connector.type, actor });
      res.json({ ok: true, connector });
    } catch (error) {
      finishDashboardExecution(execution, "failed", { result_status: "failure", error_category: "connector_registration", result_summary: "connector registration failed" });
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "connectors" });
    }
  });

  app.get("/api/connectors/:connectorId", (req, res) => {
    const connector = platformKernel.getConnector(req.params.connectorId);
    if (!connector) return res.status(404).json({ ok: false, error: "connector not found" });
    res.json({ ok: true, connector, events: platformKernel.listConnectorEvents(connector.connector_id, req.query.event_limit) });
  });

  app.get("/api/connectors/:connectorId/health", async (req, res) => {
    const connector = platformKernel.getConnector(req.params.connectorId);
    if (!connector) return res.status(404).json({ ok: false, error: "connector not found" });
    try {
      const health = await probeConnector(connector);
      const recorded = platformKernel.recordConnectorHealth(connector.connector_id, health);
      res.status(recorded.ok ? 200 : 502).json({ ok: recorded.ok, connector_id: recorded.connector.connector_id, state: recorded.connector.state, health: recorded.health, last_health_check_at: recorded.connector.last_health_check_at, probe_execution: "adapter-owned" });
    } catch (error) {
      return errorResponse(req, res, error, {
        status: 502,
        code: "upstream_unavailable",
        component: "connectors",
        publicMessage: "connector_health_failed",
        extra: { connector_id: connector.connector_id, probe_execution: "adapter-owned" },
      });
    }
  });

  app.get("/api/connectors/:connectorId/events", (req, res) => {
    const connector = platformKernel.getConnector(req.params.connectorId);
    if (!connector) return res.status(404).json({ ok: false, error: "connector not found" });
    res.json({ ok: true, events: platformKernel.listConnectorEvents(connector.connector_id, req.query.limit) });
  });

  app.post("/api/connectors/:connectorId/configure", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor) return res.status(403).json({ ok: false, error: "Connector operations require an authenticated dashboard user" });
    try {
      const connector = platformKernel.configureConnector(req.params.connectorId, { ...req.body, source: "dashboard" });
      auditLog(req, "connector.configure", { connector_id: connector.connector_id, actor, has_secret_ref: Boolean(connector.secret_ref) });
      res.json({ ok: true, connector });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "connectors" }); }
  });

  app.post("/api/connectors/:connectorId/:action", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor) return res.status(403).json({ ok: false, error: "Connector operations require an authenticated dashboard user" });
    const states = { enable: "enabled", disable: "disabled", retire: "retired" };
    const nextState = states[req.params.action];
    if (!nextState) return res.status(404).json({ ok: false, error: "unknown connector action" });
    try {
      const connector = platformKernel.transitionConnector(req.params.connectorId, nextState, { source: "dashboard", actor_id: actor });
      auditLog(req, `connector.${req.params.action}`, { connector_id: connector.connector_id, actor });
      res.json({ ok: true, connector });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "connectors" }); }
  });
}

module.exports = { registerConnectorRoutes };
