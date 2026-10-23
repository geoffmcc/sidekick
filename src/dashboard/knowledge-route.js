"use strict";

const projectAccess = require("../core/project-access");

function registerKnowledgeRoute({ app, dbStore, requireIdentityPermission, errorResponse }) {
  app.get("/api/knowledge", (req, res) => {
    if (!requireIdentityPermission(req, res, "dashboard.catalog.read")) return;
    try {
      const db = dbStore.getDb();
      const category = req.query.category;
      const requestedLimit = Number.parseInt(req.query.limit, 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 500)
        : 50;
      const principal = req.authPrincipal || null;
      const delegationId = principal?.delegation_id || principal?.delegationId || null;
      let scopeSql = "project_id IS NULL";
      let scopeParams = [];
      if (principal && projectAccess.hasGlobalProjectAccess(principal.principal_id, principal.scopes, delegationId)) {
        scopeSql = "1 = 1";
      } else if (principal) {
        const projects = projectAccess.listAccessibleProjectsForPermission(
          principal.principal_id, "knowledge.read", principal.scopes, delegationId,
        ).map(item => item.project_id);
        if (projects.length) {
          scopeSql = `(project_id IS NULL OR project_id IN (${projects.map(() => "?").join(", ")}))`;
          scopeParams = projects;
        }
      }
      const rows = category
        ? db.prepare(`
            SELECT id, category, title, tags, updated_at
            FROM knowledge
            WHERE enabled = 1 AND category = ? AND ${scopeSql}
            ORDER BY updated_at DESC
            LIMIT ?
          `).all(category, ...scopeParams, limit)
        : db.prepare(`
            SELECT id, category, title, tags, updated_at
            FROM knowledge
            WHERE enabled = 1 AND ${scopeSql}
            ORDER BY category, updated_at DESC
            LIMIT ?
          `).all(...scopeParams, limit);
      res.json({ ok: true, knowledge: rows });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "knowledge" });
    }
  });
}

module.exports = { registerKnowledgeRoute };
