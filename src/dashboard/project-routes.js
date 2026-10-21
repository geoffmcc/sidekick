"use strict";

/** Read-only project workspace projection for the Dashboard. */
function registerProjectRoutes({ app, platformKernel, projectAccess, errorResponse }) {
  app.get("/api/projects", (req, res) => {
    try {
      const principalId = req.authPrincipal?.principal_id;
      if (!principalId) return res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      const credentialScopes = req.authPrincipal?.scopes;
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
      const projects = projectAccess.hasGlobalProjectAccess(principalId, credentialScopes)
        ? platformKernel.listProjects({ state: "active", limit })
        : projectAccess.listAccessibleProjects(principalId, credentialScopes, req.authPrincipal?.delegation_id || req.authPrincipal?.delegationId || null).slice(0, limit);
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
