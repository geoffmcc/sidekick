"use strict";

function registerProjectAccessRoutes({ app, projectAccess, requireIdentityPermission, errorResponse }) {
  function authorize(req, res) {
    if (!req.authPrincipal?.principal_id) {
      res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      return false;
    }
    return requireIdentityPermission(req, res, projectAccess.MANAGE_PERMISSION);
  }

  app.get("/api/projects/:project/access", (req, res) => {
    if (!authorize(req, res)) return;
    try { res.json({ ok: true, grants: projectAccess.listProjectAccess(req.params.project) }); }
    catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "project_access" }); }
  });

  app.put("/api/projects/:project/access/:principalId", (req, res) => {
    if (!authorize(req, res)) return;
    try {
      const grant = projectAccess.grantProjectAccess({
        actorPrincipalId: req.authPrincipal.principal_id,
        credentialScopes: req.authPrincipal.scopes,
        principalId: req.params.principalId,
        project: req.params.project,
        accessLevel: req.body?.access_level,
      });
      res.json({ ok: true, grant });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "project_access" }); }
  });

  app.delete("/api/projects/:project/access/:principalId", (req, res) => {
    if (!authorize(req, res)) return;
    try {
      const revoked = projectAccess.revokeProjectAccess({ actorPrincipalId: req.authPrincipal.principal_id, credentialScopes: req.authPrincipal.scopes, principalId: req.params.principalId, project: req.params.project });
      if (!revoked) return errorResponse(req, res, null, { status: 404, code: "not_found", component: "project_access" });
      res.json({ ok: true, revoked: true });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "project_access" }); }
  });
}

module.exports = { registerProjectAccessRoutes };
