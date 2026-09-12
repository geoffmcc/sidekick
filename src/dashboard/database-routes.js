/** Dashboard database administration surface. SQL remains governed by the dispatcher. */
function registerDatabaseRoutes({ app, dbStore, dataDir, path, fs, callDashboardTool, dashboardExecutionMetadata, authenticatedUser, requireDashboardTool, auditLog, errorResponse }) {
  app.get("/api/db/schema", (req, res) => {
    if (!requireDashboardTool(req, res, "sidekick_db_schema")) return;
    try {
      const db = dbStore.getDb();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const schema = {};
      for (const table of tables) {
        const identifier = table.name.replaceAll('"', '""');
        schema[table.name] = {
          columns: db.prepare(`PRAGMA table_info("${identifier}")`).all(),
          indexes: db.prepare(`PRAGMA index_list("${identifier}")`).all(),
          rowCount: db.prepare(`SELECT COUNT(*) AS count FROM "${identifier}"`).get().count,
        };
      }
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

  app.get("/api/db/stats", (req, res) => {
    if (!requireDashboardTool(req, res, "sidekick_db_stats")) return;
    try {
      const db = dbStore.getDb();
      const dbPath = path.join(dataDir, "sidekick.db");
      const stats = fs.statSync(dbPath);
      const walMode = db.prepare("PRAGMA journal_mode").get();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      const pageCount = db.prepare("PRAGMA page_count").get();
      const pageSize = db.prepare("PRAGMA page_size").get();
      res.json({ ok: true, size: stats.size, tableCount: tables.length, walMode: walMode?.journal_mode, dbSize: (pageCount?.page_count || 0) * (pageSize?.page_size || 4096) });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });

  app.post("/api/db/backup", (req, res) => {
    if (!requireDashboardTool(req, res, "sidekick_db_backup")) return;
    try {
      const backupDir = path.join(dataDir, "backups"); fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `sidekick-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      dbStore.getDb().backup(backupPath).then(() => { auditLog(req, "db.backup", { path: backupPath }); res.json({ ok: true, path: backupPath }); }).catch(error => errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }));
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });

  app.get("/api/db/search", async (req, res) => {
    if (!requireDashboardTool(req, res, "sidekick_db_search")) return;
    try {
      if (!req.query.q) return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "database" });
      const parsedLimit = Number.parseInt(req.query.limit, 10);
      const result = await callDashboardTool("db_search", { query: String(req.query.q), limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50 }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
      const text = result?.content?.[0]?.text || "";
      if (result?.isError) return errorResponse(req, res, null, { status: 502, code: "upstream_unavailable", component: "database" });
      let results; try { results = JSON.parse(text); } catch { results = text; }
      res.json({ ok: true, results });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });

  app.get("/api/db/migrations", (req, res) => {
    if (!requireDashboardTool(req, res, "sidekick_db_migrate")) return;
    try {
      const currentVersion = Number.parseInt(dbStore.getDb().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || "0", 10);
      const migrationDir = path.join(__dirname, "..", "..", "migrations");
      const migrations = fs.existsSync(migrationDir) ? fs.readdirSync(migrationDir).filter(file => file.endsWith(".sql")).map(file => ({ file, version: Number.parseInt(file.match(/^\d+/)?.[0] || "0", 10), applied: Number.parseInt(file.match(/^\d+/)?.[0] || "0", 10) <= currentVersion })).sort((a, b) => a.version - b.version) : [];
      res.json({ ok: true, currentVersion, migrations });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "database" }); }
  });
}

module.exports = { registerDatabaseRoutes };
