"use strict";

const { canonicalizeProjectName } = require("../core/project-identity");

function registerMemoryReadRoutes({ app, dbStore, memoryCategory, projectAccess, errorResponse }) {
  app.get("/api/memories", (req, res) => {
    try {
      const { project, type, include_disabled, limit, query } = req.query;
      const options = { limit: parseInt(limit) || 100, includeDisabled: include_disabled === "true" };
      const principalId = req.authPrincipal?.principal_id;
      const credentialScopes = req.authPrincipal?.scopes;
      const delegationId = req.authPrincipal?.delegation_id || req.authPrincipal?.delegationId || null;
      if (!principalId) return res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      const globalAccess = projectAccess.hasGlobalMemoryAccess(principalId, "read", credentialScopes, delegationId);
      if (!project && !globalAccess) return res.status(400).json({ ok: false, error: "project is required", code: "project_scope_required" });
      if (project && !projectAccess.hasProjectAccess(principalId, project, "read", credentialScopes, delegationId)) return res.status(403).json({ ok: false, error: "project access denied", code: "project_access_denied" });
      const normalizedProject = project ? canonicalizeProjectName(project) : null;
      if (normalizedProject) options.project = normalizedProject;
      if (type) options.type = type;
      if (query) options.query = query;
      const memories = dbStore.searchMemories(options).filter(memory => (globalAccess && !normalizedProject) || memory.project === normalizedProject);
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
      const principalId = req.authPrincipal?.principal_id;
      if (!principalId) return res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      const credentialScopes = req.authPrincipal?.scopes;
      const delegationId = req.authPrincipal?.delegation_id || req.authPrincipal?.delegationId || null;
      const projects = projectAccess.hasGlobalMemoryAccess(principalId, "read", credentialScopes, delegationId)
        ? dbStore.getDb().prepare("SELECT DISTINCT project FROM memories WHERE project IS NOT NULL AND project != '' AND enabled = 1 ORDER BY project").all().map(row => row.project)
        : projectAccess.listAccessibleProjects(principalId, credentialScopes, delegationId).map(row => row.project_id);
      res.json({ ok: true, projects });
    } catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memories" }); }
  });

  app.get("/api/memories/types", (req, res) => {
    try {
      if (!req.authPrincipal?.principal_id || !projectAccess.hasGlobalMemoryAccess(req.authPrincipal.principal_id, "read", req.authPrincipal.scopes, req.authPrincipal.delegation_id || req.authPrincipal.delegationId || null)) return res.status(403).json({ ok: false, error: "global memory access required", code: "forbidden" });
      const rows = dbStore.getDb().prepare("SELECT DISTINCT type FROM memories ORDER BY type").all();
      res.json({ ok: true, types: rows.map(r => r.type) });
    } catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memories" }); }
  });

  app.get("/api/memories/stats", (req, res) => {
    try {
      if (!req.authPrincipal?.principal_id || !projectAccess.hasGlobalMemoryAccess(req.authPrincipal.principal_id, "read", req.authPrincipal.scopes, req.authPrincipal.delegation_id || req.authPrincipal.delegationId || null)) return res.status(403).json({ ok: false, error: "global memory access required", code: "forbidden" });
      res.json({ ok: true, stats: dbStore.getMemoryIntelligenceStats() });
    }
    catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memories" }); }
  });
}

module.exports = { registerMemoryReadRoutes };
