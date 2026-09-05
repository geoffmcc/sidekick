function registerSyncRoutes({ app, dbStore, auditLog, errorResponse }) {
  app.get("/api/sync/identity", (req, res) => {
    try {
      res.json({ ok: true, machine_id: dbStore.getMachineId(), user_id: dbStore.getUserId() });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "sync" }); }
  });

  app.post("/api/sync/identity", (req, res) => {
    try {
      const { user_id } = req.body || {};
       if (!user_id || typeof user_id !== "string") return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "sync" });
      dbStore.setUserId(user_id);
      auditLog(req, "sync_set_user_id", { user_id });
      res.json({ ok: true, user_id });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "sync" }); }
  });

  app.get("/api/sync/export", (req, res) => {
    try {
      const { project, since, include_disabled } = req.query;
      const options = {};
      if (project) options.project = project;
      if (since) options.since = since;
      if (include_disabled === "false") options.includeDisabled = false;
      const data = dbStore.exportForSync(options);
      auditLog(req, "sync_export", { count: data.count, project, since });
      res.json({ ok: true, data });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "sync" }); }
  });

  app.post("/api/sync/import", (req, res) => {
    try {
      const { data, strategy, preserve_ids } = req.body || {};
      const result = dbStore.importFromSync(data, { strategy: strategy || "newest", preserveIds: preserve_ids === true });
      auditLog(req, "sync_import", { imported: result.imported, conflicts: result.conflicts, strategy });
      res.json({ ok: true, ...result });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "sync" }); }
  });

  app.get("/api/sync/diff", (req, res) => {
    try {
       if (!req.query.since) return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "sync" });
      res.json({ ok: true, ...dbStore.getSyncDiff(req.query.since) });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "sync" }); }
  });
}

module.exports = { registerSyncRoutes };
