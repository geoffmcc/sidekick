function registerPerformanceRoutes({ app, metrics, errorResponse, requireIdentityPermission }) {
  app.get("/api/dashboard-performance", (req, res) => {
    if (typeof requireIdentityPermission !== "function") {
      return res.status(503).json({ error: "authorization unavailable", code: "authorization_unavailable" });
    }
    if (!requireIdentityPermission(req, res, "dashboard.operations.read")) return;
    try {
      res.set("Cache-Control", "no-store");
      return res.json({ ok: true, schema: "sidekick.dashboard.performance.v1", metrics: metrics.snapshot() });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "performance" });
    }
  });
}
module.exports = { registerPerformanceRoutes };
