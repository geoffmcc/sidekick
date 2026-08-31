/**
 * Dashboard KV inspection and mutation routes.
 *
 * Persistence and formatting helpers are injected so this module owns only
 * HTTP behavior while the dashboard bootstrap retains its existing services.
 */
function registerKvRoutes({
  app,
  readKV,
  writeKV,
  safeString,
  summarizeValue,
  inferNamespace,
  valueSize,
  valueType,
  auditLog,
  requireIdentityAdministrator,
}) {
  function requireAdmin(req, res) {
    if (!req.authPrincipal || !requireIdentityAdministrator) return true;
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
    const kv = readKV();
    const entries = Object.entries(kv).map(([key, entry]) => shapeKvEntry(key, entry));
    const namespaces = [...new Set(entries.map(entry => entry.namespace))].sort();
    const projects = [...new Set(entries.map(entry => entry.project).filter(Boolean))].sort();
    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentlyChanged = entries.filter(entry => entry.updated && new Date(entry.updated).getTime() >= recentCutoff).length;
    res.json({
      entries,
      total: entries.length,
      summary: {
        total_entries: entries.length,
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
      const kv = readKV();
      const now = new Date().toISOString();
      const existing = kv[req.params.key];
      if (existing && typeof existing === "object" && "value" in existing) {
        kv[req.params.key] = {
          value,
          project: project !== undefined ? project : existing.project,
          source: existing.source,
          created: existing.created,
          updated: now,
        };
      } else {
        kv[req.params.key] = { value, project: project || null, source: "dashboard", created: now, updated: now };
      }
      writeKV(kv);
      auditLog(req, "kv.update", { value_length: value?.length, project });
      res.json({ ok: true });
    } catch { res.status(400).json({ error: "invalid body" }); }
  });

  app.get("/api/kv/projects", (req, res) => {
    const projects = new Set();
    for (const entry of Object.values(readKV())) {
      if (typeof entry === "object" && entry !== null && "project" in entry) projects.add(entry.project);
    }
    res.json({ projects: Array.from(projects) });
  });

  app.delete("/api/kv/:key", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const kv = readKV();
    const existed = Object.prototype.hasOwnProperty.call(kv, req.params.key);
    if (!existed) {
      auditLog(req, "kv.delete", { key: req.params.key, deleted: false });
      return res.status(404).json({ ok: false, deleted: false, error: "key not found" });
    }
    delete kv[req.params.key];
    writeKV(kv);
    auditLog(req, "kv.delete", { key: req.params.key, deleted: true });
    res.json({ ok: true, deleted: true });
  });
}

module.exports = { registerKvRoutes };
