/**
 * Read-only dashboard system, service, and metrics routes.
 */
function registerSystemRoutes({
  app,
  systemSnapshot,
  systemctlStatus,
  getJsonFromLocalService,
  http,
  grafanaPort,
  grafanaConfigured,
  influxConfigured,
}) {
  app.get("/api/system", (req, res) => {
    try {
      const snapshot = systemSnapshot();
      res.json({
        uptime: snapshot.uptime,
        memory: { total: snapshot.memory.total, used: snapshot.memory.used, free: snapshot.memory.free, pct: snapshot.memory.pct },
        disk: { total: snapshot.disk.total, free: snapshot.disk.free, pct: snapshot.disk.pct },
        load_1m: snapshot.load_1m,
        cpu_count: snapshot.cpu_count,
        load: snapshot.load,
      });
    } catch (error) {
      res.json({ error: error.message });
    }
  });

  app.get("/api/services", (req, res) => {
    const services = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent", "ollama"];
    const status = Object.fromEntries(services.map(service => [service, systemctlStatus(service)]));
    res.json({ services: status });
  });

  app.get("/api/metrics/status", async (req, res) => {
    const status = {
      grafana: { configured: grafanaConfigured, reachable: false },
      influxdb: { configured: influxConfigured, reachable: false },
      collector: { timerActive: false, timerEnabled: false },
    };

    try {
      await getJsonFromLocalService(grafanaPort, "/api/health");
      status.grafana.reachable = true;
    } catch {}

    try {
      await new Promise((resolve, reject) => {
        const request = http.get({ hostname: "127.0.0.1", port: 8086, path: "/ping", timeout: 3000 }, response => {
          response.resume();
          response.statusCode >= 200 && response.statusCode < 500 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`));
        });
        request.on("timeout", () => request.destroy(new Error("timeout")));
        request.on("error", reject);
      });
      status.influxdb.reachable = true;
    } catch {}

    try {
      status.collector.timerActive = systemctlStatus("sidekick-metrics.timer", "is-active") === "active";
      status.collector.timerEnabled = systemctlStatus("sidekick-metrics.timer", "is-enabled") === "enabled";
    } catch {}

    const issues = [];
    if (!status.grafana.configured) issues.push("SIDEKICK_GRAFANA_ADMIN_USER is not configured for the Grafana auth proxy");
    if (!status.grafana.reachable) issues.push("Grafana is not reachable on localhost");
    if (!status.influxdb.configured) issues.push("SIDEKICK_INFLUX_TOKEN is not configured for metrics collection");
    if (!status.influxdb.reachable) issues.push("InfluxDB is not reachable on localhost");
    if (!status.collector.timerActive) issues.push("sidekick-metrics.timer is not active");
    status.ok = issues.length === 0;
    status.issues = issues;
    res.json(status);
  });
}

module.exports = { registerSystemRoutes };
