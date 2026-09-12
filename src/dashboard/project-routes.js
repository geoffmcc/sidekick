"use strict";

/** Read-only project workspace projection for the Dashboard. */
function registerProjectRoutes({ app, platformKernel, errorResponse }) {
  app.get("/api/projects", (req, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
      const projects = platformKernel.listProjects({ state: "active", limit });
      const rows = projects.map(project => ({
        project,
        workspace: platformKernel.getWorkspaceByProject(project.project_id) || null,
        sources: platformKernel.getProjectSources(project.project_id),
      }));
      res.json({ ok: true, projects: rows, total: rows.length });
    } catch (error) {
      return errorResponse(req, res, error, { status: 503, code: "service_unavailable", component: "projects", publicMessage: "Project registry unavailable" });
    }
  });
}

module.exports = { registerProjectRoutes };
