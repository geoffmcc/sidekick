/** Register governed dashboard quick actions. */
function registerQuickActionsRoute({
  app, startDashboardExecution, finishDashboardExecution, systemctlStatus, systemSnapshot,
  dbStore, auditLog, callDashboardTool, dashboardExecutionMetadata, authenticatedUser,
  logError, fs, path, rootDir,
}) {
  app.post("/api/quick-actions/:action", async (req, res) => {
    const action = req.params.action;
    const execution = startDashboardExecution(req, action);
    try {
      if (action === "health-check") {
        const services = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent", "ollama"];
        const serviceStatus = Object.fromEntries(services.map(service => [service, systemctlStatus(service)]));
        const snapshot = systemSnapshot();
        auditLog(req, "quick-action.health-check", {});
        finishDashboardExecution(execution, "completed", { result_status: "success", result_summary: "dashboard health check completed" });
        return res.json({ ok: true, action, result: { services: serviceStatus, uptime: snapshot.uptime, load: snapshot.load, disk: `${snapshot.disk.pct} used, ${snapshot.disk.free} free`, memory: `${snapshot.memory.used}/${snapshot.memory.total} used` } });
      }
      if (action === "recent-failures") {
        const failures = dbStore.readToolLogs(200).filter(entry => !entry.ok).slice(0, 8).map(entry => ({ time: entry.t, tool: entry.n, source: entry.src || "unknown", summary: (entry.s || "").slice(0, 240) }));
        auditLog(req, "quick-action.recent-failures", { count: failures.length });
        finishDashboardExecution(execution, "completed", { result_status: "success", result_summary: `dashboard recent failures returned ${failures.length} entries` });
        return res.json({ ok: true, action, result: { failures } });
      }
      if (action === "deployment") {
        const versionFile = path.join(rootDir, "version.json");
        const version = fs.existsSync(versionFile) ? JSON.parse(fs.readFileSync(versionFile, "utf-8")) : {};
        auditLog(req, "quick-action.deployment", {});
        finishDashboardExecution(execution, "completed", { result_status: "success", result_summary: "dashboard deployment metadata returned" });
        return res.json({ ok: true, action, result: { commit: version.commit || "unknown", branch: version.branch || "unknown", remote: version.remote_url || "unknown", deployedAt: version.deployed_at || "unknown" } });
      }
      if (action === "service-logs") {
        const allowedServices = new Set(["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"]);
        const service = String(req.body?.service || "sidekick-mcp");
        if (!allowedServices.has(service)) {
          finishDashboardExecution(execution, "failed", { result_status: "invalid_request", error_category: "unsupported_service", result_summary: `Unsupported service: ${service}` });
          return res.status(400).json({ ok: false, error: "Unsupported service" });
        }
        const result = await callDashboardTool("service", { action: "logs", service, lines: 40 }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
        const text = result?.content?.[0]?.text || "";
        auditLog(req, "quick-action.service-logs", { service, ok: !result?.isError });
        if (result?.isError) {
          finishDashboardExecution(execution, "failed", { result_status: result.code || "error", error_category: "service_logs", result_summary: text.slice(0, 200) });
          return res.status(result.approvalRequired ? 202 : result.code === "policy_denied" ? 403 : 500).json({ ok: false, error: text || "service logs unavailable", approvalRequired: !!result.approvalRequired });
        }
        finishDashboardExecution(execution, "completed", { result_status: "success", result_summary: `dashboard service logs returned for ${service}` });
        return res.json({ ok: true, action, result: { service, logs: text } });
      }
      if (action === "restart-agent") {
        const result = await callDashboardTool("service", { action: "restart", service: "sidekick-agent" }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
        const text = result?.content?.[0]?.text || "";
        if (result?.isError) {
          auditLog(req, "quick-action.restart-agent", { ok: false, code: result.code || "error" });
          finishDashboardExecution(execution, "failed", { result_status: result.code || "error", error_category: "service_restart", result_summary: text.slice(0, 200) });
          return res.status(result.approvalRequired ? 202 : result.code === "policy_denied" ? 403 : 500).json({ ok: false, error: text || "restart refused", approvalRequired: !!result.approvalRequired });
        }
        const status = systemctlStatus("sidekick-agent");
        auditLog(req, "quick-action.restart-agent", { status });
        finishDashboardExecution(execution, status === "active" ? "completed" : "failed", { result_status: status === "active" ? "success" : "failed", result_summary: `sidekick-agent restart status: ${status}` });
        return res.json({ ok: status === "active", action, result: { service: "sidekick-agent", status } });
      }
      finishDashboardExecution(execution, "failed", { result_status: "not_found", error_category: "unknown_action", result_summary: `Unknown quick action: ${action}` });
      res.status(404).json({ ok: false, error: "Unknown quick action" });
    } catch (error) {
      finishDashboardExecution(execution, "failed", { result_status: "error", error_category: "dashboard_action_error", result_summary: error.message, reason: error.message });
      logError(req.originalUrl, 500, error, "mission", req.headers["user-agent"]);
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerQuickActionsRoute };
