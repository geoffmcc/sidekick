function registerPerformanceRoutes({ app, metrics }) {
  app.get("/api/dashboard-performance", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, schema: "sidekick.dashboard.performance.v1", metrics: metrics.snapshot() });
  });
}
module.exports = { registerPerformanceRoutes };
