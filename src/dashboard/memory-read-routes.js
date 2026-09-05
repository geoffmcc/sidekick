function registerMemoryReadRoutes({ app, dbStore, memoryCategory, errorResponse }) {
  app.get("/api/memories", (req, res) => {
    try {
      const { project, type, include_disabled, limit, query } = req.query;
      const options = { limit: parseInt(limit) || 100, includeDisabled: include_disabled === "true" };
      if (project) options.project = project;
      if (type) options.type = type;
      if (query) options.query = query;
      const memories = dbStore.searchMemories(options);
      const formatted = memories.map(m => ({
        id: m.id, type: m.type, category: memoryCategory(m), project: m.project,
        content: m.content, summary: m.summary, tags: m.tags, confidence: m.confidence,
        importance: m.metadata?.importance || (m.confidence >= 0.8 ? "high" : m.confidence >= 0.55 ? "normal" : "low"),
        source: m.source, source_tool: m.source_tool, source_task_id: m.source_task_id,
        source_ref: m.source_ref, enabled: m.enabled, automatic: m.automatic,
        times_confirmed: m.times_confirmed, state: m.state || m.metadata?.state || "active",
        memory_class: m.memory_class, primary_scope_type: m.primary_scope_type,
        primary_scope_id: m.primary_scope_id, source_type: m.source_type,
        evidence_excerpt: m.evidence_excerpt, directness: m.directness,
        source_authority: m.source_authority, confidence_components: m.confidence_components,
        observed_at: m.observed_at, valid_from: m.valid_from, valid_to: m.valid_to,
        revalidate_after: m.revalidate_after, pinned: m.pinned, sensitivity: m.sensitivity,
        current: m.current, supersedes_id: m.supersedes_id, conflict_group: m.conflict_group,
        requires_confirmation: m.requires_confirmation, last_confirmed_at: m.last_confirmed_at,
        expires_at: m.expires_at, deleted_at: m.deleted_at, expired_at: m.expired_at,
        metadata: m.metadata || {}, created_at: m.created_at, updated_at: m.updated_at,
        last_seen_at: m.last_seen_at,
      }));
      res.json({ ok: true, memories: formatted, count: formatted.length });
    } catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memories" }); }
  });

  app.get("/api/memories/projects", (req, res) => {
    try {
      const rows = dbStore.getDb().prepare("SELECT DISTINCT project FROM memories WHERE project IS NOT NULL AND project != '' AND enabled = 1 ORDER BY project").all();
      res.json({ ok: true, projects: rows.map(r => r.project) });
    } catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memories" }); }
  });

  app.get("/api/memories/types", (req, res) => {
    try {
      const rows = dbStore.getDb().prepare("SELECT DISTINCT type FROM memories ORDER BY type").all();
      res.json({ ok: true, types: rows.map(r => r.type) });
    } catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memories" }); }
  });

  app.get("/api/memories/stats", (req, res) => {
    try { res.json({ ok: true, stats: dbStore.getMemoryIntelligenceStats() }); }
    catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memories" }); }
  });
}

module.exports = { registerMemoryReadRoutes };
