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
  requireIdentityPermission,
  startDashboardExecution,
  finishDashboardExecution,
  auditLog,
  errorResponse,
}) {
  app.get("/api/connectors", (req, res) => {
    if (!requireIdentityPermission(req, res, "connectors.read")) return;
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
    if (!actor || !requireIdentityPermission(req, res, "connectors.manage")) return;
    try { auditLog(req, "connector.register.requested", { name: String(req.body?.name || "").slice(0, 120), type: String(req.body?.type || "").slice(0, 80), actor }); }
    catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "connectors" }); }
    let execution = null;
    try {
      execution = startDashboardExecution(req, "connector.register");
      const connector = platformKernel.registerConnector({ ...req.body, source: "dashboard", actor_id: actor });
      finishDashboardExecution(execution, "completed", { result_status: "success", result_summary: `connector ${connector.name} registered` });
      let auditStatus = "complete";
      try { auditLog(req, "connector.register", { connector_id: connector.connector_id, name: connector.name, type: connector.type, actor }); }
      catch { auditStatus = "degraded"; }
      res.json({ ok: true, connector, audit_status: auditStatus });
    } catch (error) {
      finishDashboardExecution(execution, "failed", { result_status: "failure", error_category: "connector_registration", result_summary: "connector registration failed" });
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "connectors" });
    }
  });

  app.get("/api/connectors/:connectorId", (req, res) => {
    if (!requireIdentityPermission(req, res, "connectors.read")) return;
    const connector = platformKernel.getConnector(req.params.connectorId);
    if (!connector) return res.status(404).json({ ok: false, error: "connector not found" });
    res.json({ ok: true, connector, events: platformKernel.listConnectorEvents(connector.connector_id, req.query.event_limit) });
  });

  app.get("/api/connectors/:connectorId/health", async (req, res) => {
    if (!requireIdentityPermission(req, res, "connectors.read")) return;
    if (!requireIdentityPermission(req, res, "secrets.use")) return;
    const connector = platformKernel.getConnector(req.params.connectorId);
    if (!connector) return res.status(404).json({ ok: false, error: "connector not found" });
    try {
      const health = await probeConnector(connector, {
        context: { source: "dashboard", authIdentity: req.authPrincipal || null },
      });
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
    if (!requireIdentityPermission(req, res, "connectors.read")) return;
    const connector = platformKernel.getConnector(req.params.connectorId);
    if (!connector) return res.status(404).json({ ok: false, error: "connector not found" });
    res.json({ ok: true, events: platformKernel.listConnectorEvents(connector.connector_id, req.query.limit) });
  });

  app.post("/api/connectors/:connectorId/configure", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor || !requireIdentityPermission(req, res, "connectors.manage")) return;
    try {
      auditLog(req, "connector.configure.requested", { connector_id: req.params.connectorId, actor });
    } catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "connectors" }); }
    let connector;
    try { connector = platformKernel.configureConnector(req.params.connectorId, { ...req.body, source: "dashboard", actor_id: actor }); }
    catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "connectors" }); }
    let auditStatus = "complete";
    try { auditLog(req, "connector.configure", { connector_id: connector.connector_id, actor, has_secret_ref: Boolean(connector.secret_ref) }); }
    catch { auditStatus = "degraded"; }
    res.json({ ok: true, connector, audit_status: auditStatus });
  });

  app.post("/api/connectors/:connectorId/:action", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor || !requireIdentityPermission(req, res, "connectors.manage")) return;
    const states = { enable: "enabled", disable: "disabled", retire: "retired" };
    const nextState = states[req.params.action];
    if (!nextState) return res.status(404).json({ ok: false, error: "unknown connector action" });
    try { auditLog(req, `connector.${req.params.action}.requested`, { connector_id: req.params.connectorId, actor }); }
    catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "connectors" }); }
    let connector;
    try { connector = platformKernel.transitionConnector(req.params.connectorId, nextState, { source: "dashboard", actor_id: actor }); }
    catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "connectors" }); }
    let auditStatus = "complete";
    try { auditLog(req, `connector.${req.params.action}`, { connector_id: connector.connector_id, actor }); }
    catch { auditStatus = "degraded"; }
    res.json({ ok: true, connector, audit_status: auditStatus });
  });
}

module.exports = { registerConnectorRoutes };
