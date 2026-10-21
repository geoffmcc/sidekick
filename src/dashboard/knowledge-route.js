"use strict";

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
      const rows = category
        ? db.prepare(`
            SELECT id, category, title, tags, updated_at
            FROM knowledge
            WHERE enabled = 1 AND category = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `).all(category, limit)
        : db.prepare(`
            SELECT id, category, title, tags, updated_at
            FROM knowledge
            WHERE enabled = 1
            ORDER BY category, updated_at DESC
            LIMIT ?
          `).all(limit);
      res.json({ ok: true, knowledge: rows });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "knowledge" });
    }
  });
}

module.exports = { registerKnowledgeRoute };
