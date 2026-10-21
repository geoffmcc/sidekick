/**
 * Dashboard KV inspection and mutation routes.
 *
 * Database operations are injected so this module owns only HTTP behavior.
 */
function registerKvRoutes({
  app,
  dbStore,
  safeString,
  summarizeValue,
  inferNamespace,
  valueSize,
  valueType,
  auditLog,
  requireIdentityAdministrator,
  requireIdentityPermission,
  errorResponse,
}) {
  function requireAdmin(req, res) {
    if (typeof requireIdentityAdministrator !== "function") {
      res.status(503).json({ ok: false, error: "authorization service unavailable", code: "authorization_unavailable" });
      return false;
    }
    return requireIdentityAdministrator(req, res);
  }
  const shapeKvEntry = (key, entry) => {
    const isEnvelope = entry && typeof entry === "object" && !Array.isArray(entry) && Object.prototype.hasOwnProperty.call(entry, "value");
    const value = isEnvelope ? entry.value : entry;
    return {
      key,
      value,
      value_text: safeString(value),
      preview: summarizeValue(value, 180),
      project: isEnvelope ? entry.project || null : null,
      source: isEnvelope ? entry.source || null : null,
      category: isEnvelope ? entry.category || null : null,
      namespace: inferNamespace(key),
      size: valueSize(value),
      data_type: valueType(value),
      created: isEnvelope ? entry.created || null : null,
      updated: isEnvelope ? entry.updated || null : null,
    };
  };

  app.get("/api/kv", (req, res) => {
    if (!requireIdentityPermission(req, res, "kv.read")) return;
    const page = dbStore.listKVPage(1000);
    const entries = page.entries.map(([key, entry]) => shapeKvEntry(key, entry));
    const namespaces = [...new Set(entries.map(entry => entry.namespace))].sort();
    const projects = [...new Set(entries.map(entry => entry.project).filter(Boolean))].sort();
    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const total = dbStore.countKV();
    const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentlyChanged = entries.filter(entry => entry.updated && new Date(entry.updated).getTime() >= recentCutoff).length;
    res.json({
      entries,
      total,
      truncated: page.truncated || page.oversized > 0,
      omitted_oversized: page.oversized,
      summary: {
        total_entries: total,
        projects: projects.length,
        total_size: totalSize,
        recently_changed: recentlyChanged,
        namespaces: namespaces.length,
        largest_entries: [...entries].sort((a, b) => b.size - a.size).slice(0, 5).map(entry => ({ key: entry.key, size: entry.size })),
      },
      namespaces,
      projects,
    });
  });

  app.put("/api/kv/:key", (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { value, project } = req.body || {};
      const existing = dbStore.getKV(req.params.key);
      const effectiveProject = project !== undefined ? project : (existing?.project || null);
      dbStore.setKV(req.params.key, value, effectiveProject, "dashboard", existing?.category || "system");
      auditLog(req, "kv.update", { value_length: value?.length, project });
      res.json({ ok: true });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_body", component: "kv" }); }
  });

  app.get("/api/kv/projects", (req, res) => {
    if (!requireIdentityPermission(req, res, "kv.read")) return;
    const page = dbStore.listKVProjectPage(1000);
    res.json({ projects: page.projects, truncated: page.truncated });
  });

  app.delete("/api/kv/:key", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const existed = dbStore.hasKV(req.params.key);
    if (!existed) {
      auditLog(req, "kv.delete", { key: req.params.key, deleted: false });
      return errorResponse(req, res, null, { status: 404, code: "not_found", component: "kv", publicMessage: "key not found", extra: { deleted: false } });
    }
    dbStore.deleteKV(req.params.key);
    auditLog(req, "kv.delete", { key: req.params.key, deleted: true });
    res.json({ ok: true, deleted: true });
  });
}

module.exports = { registerKvRoutes };
