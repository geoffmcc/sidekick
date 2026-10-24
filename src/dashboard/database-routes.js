/** Dashboard database administration surface. SQL remains governed by the dispatcher. */
function registerDatabaseRoutes({ app, dataDir, path, callDashboardTool, dashboardExecutionMetadata, authenticatedUser, requireDashboardTool, requireIdentityPermission, auditLog, errorResponse }) {
  async function callDatabaseTool(req, res, name, args) {
    const result = await callDashboardTool(name, args, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
    if (result?.isError) {
      if (result.approvalRequired) {
        res.status(202).json({ ok: false, code: "approval_required", approval_id: result.approvalId || null });
        return null;
      }
      const code = result.code === "authorization_denied" ? "forbidden"
        : result.code === "policy_denied" ? "policy_denied"
        : result.code === "unauthenticated" ? "unauthenticated"
        : "upstream_unavailable";
      const status = code === "forbidden" || code === "policy_denied" ? 403 : code === "unauthenticated" ? 401 : 502;
      errorResponse(req, res, null, { status, code, component: "database" });
      return null;
    }
    try {
      const text = result?.content?.[0]?.text || "";
      return JSON.parse(text);
    } catch {
      errorResponse(req, res, null, { status: 502, code: "upstream_unavailable", component: "database" });
      return null;
    }
  }

  app.get("/api/db/schema", async (req, res) => {
    if (!requireIdentityPermission(req, res, "database.inspect")) return;
    if (!requireDashboardTool(req, res, "sidekick_db_schema")) return;
    try {
      const tables = await callDatabaseTool(req, res, "db_schema", { verbose: true });
      if (!tables) return;
      const schema = {};
      for (const table of tables) schema[table.name] = { columns: table.columns, indexes: table.indexes, rowCount: table.rowCount };
      res.json({ ok: true, schema });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });

  app.post("/api/db/query", async (req, res) => {
    if (!requireDashboardTool(req, res, "sidekick_db_query")) return;
    try {
      const { sql, params, readonly, limit } = req.body || {};
      if (!sql) return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "database" });
      const started = Date.now();
      const result = await callDashboardTool("db_query", { sql, params: params || [], readonly: readonly !== false, limit: limit || 1000 }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
      const text = result?.content?.[0]?.text || "";
      if (result?.isError) return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "database" });
      let rows; try { rows = JSON.parse(text); } catch { rows = text; }
      res.json({ ok: true, rows, duration: Date.now() - started, count: Array.isArray(rows) ? rows.length : undefined });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });

  app.get("/api/db/stats", async (req, res) => {
    if (!requireIdentityPermission(req, res, "database.inspect")) return;
    if (!requireDashboardTool(req, res, "sidekick_db_stats")) return;
    try {
      const stats = await callDatabaseTool(req, res, "db_stats", { detailed: false });
      if (!stats) return;
      res.json({ ok: true, size: stats.dbSize, tableCount: stats.totalTables, walMode: stats.journalMode, dbSize: (stats.pageCount || 0) * (stats.pageSize || 4096) });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });

  app.post("/api/db/backup", async (req, res) => {
    if (!requireIdentityPermission(req, res, "tools.execute")) return;
    if (!requireDashboardTool(req, res, "sidekick_db_backup")) return;
    try {
      const backupPath = path.join(dataDir, "backups", `sidekick-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      // Persist an actor-attributed record before exporting the database. If
      // audit storage is unavailable, do not create a sensitive backup.
      try { auditLog(req, "db.backup.requested", { path: backupPath }); }
      catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "database" }); }
      const result = await callDashboardTool("db_backup", { path: backupPath, compress: false }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
      if (result?.isError) {
        if (result.approvalRequired) {
          return res.status(202).json({ ok: false, code: "approval_required", approval_id: result.approvalId || null });
        }
        const code = result.code === "authorization_denied" ? "forbidden" : result.code === "policy_denied" ? "policy_denied" : "service_unavailable";
        const status = code === "forbidden" || code === "policy_denied" ? 403 : 502;
        return errorResponse(req, res, null, { status, code, component: "database" });
      }
      let auditStatus = "complete";
      try { auditLog(req, "db.backup.completed", { path: backupPath }); }
      catch { auditStatus = "degraded"; }
      res.json({ ok: true, path: backupPath, audit_status: auditStatus });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });

  app.get("/api/db/search", async (req, res) => {
    if (!requireDashboardTool(req, res, "sidekick_db_search")) return;
    try {
      if (!req.query.q) return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "database" });
      if (String(req.query.q).length > 500) return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "database" });
      const parsedLimit = Number.parseInt(req.query.limit, 10);
      const result = await callDashboardTool("db_search", { query: String(req.query.q), limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50 }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
      const text = result?.content?.[0]?.text || "";
      if (result?.isError) return errorResponse(req, res, null, { status: 502, code: "upstream_unavailable", component: "database" });
      let results; try { results = JSON.parse(text); } catch { results = text; }
      res.json({ ok: true, results });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });

  app.get("/api/db/migrations", async (req, res) => {
    if (!requireIdentityPermission(req, res, "tools.execute_high")) return;
    if (!requireDashboardTool(req, res, "sidekick_db_migrate")) return;
    try {
      const status = await callDatabaseTool(req, res, "db_migrate", { action: "status" });
      if (!status) return;
      res.json({ ok: true, ...status });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });
}

module.exports = { registerDatabaseRoutes };
