function registerPerformanceRoutes({ app, metrics, errorResponse }) {
  app.get("/api/dashboard-performance", (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      return res.json({ ok: true, schema: "sidekick.dashboard.performance.v1", metrics: metrics.snapshot() });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "performance" });
    }
  });
}
module.exports = { registerPerformanceRoutes };
