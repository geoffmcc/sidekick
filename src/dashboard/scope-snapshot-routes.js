"use strict";

function registerScopeSnapshotRoutes({ app, platformKernel, projectAccess, authenticatedUser, requireIdentityPermission, auditLog, errorResponse }) {
  function principal(req, res) {
    if (!req.authPrincipal?.principal_id) {
      res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      return null;
    }
    return req.authPrincipal;
  }

  function accessibleProject(actor, projectId, access) {
    let project;
    try { project = platformKernel.getProject(projectId); } catch { return null; }
    if (!project || project.state !== "active") return null;
    return projectAccess.hasProjectAccess(actor.principal_id, project.project_id, access, actor.scopes, actor.delegation_id || actor.delegationId || null) ? project : null;
  }

  app.get("/api/scope-snapshots", (req, res) => {
    const actor = principal(req, res);
    if (!actor || !requireIdentityPermission(req, res, "scopes.read")) return;
    if (!req.query.project_id) return res.status(400).json({ ok: false, error: "project_id is required for scope access", code: "project_scope_required" });
    if (!accessibleProject(actor, req.query.project_id, "read")) return res.status(404).json({ ok: false, error: "project not found", code: "not_found" });
    try {
      const snapshots = platformKernel.listScopeSnapshots({ project_id: req.query.project_id, state: req.query.state, limit: req.query.limit });
      res.json({ ok: true, snapshots, total: snapshots.length });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "scope_snapshots" }); }
  });

  app.post("/api/scope-snapshots", (req, res) => {
    const actor = principal(req, res);
    if (!actor || !requireIdentityPermission(req, res, "scopes.manage")) return;
    const project = accessibleProject(actor, req.body?.project_id, "write");
    if (!project) return res.status(404).json({ ok: false, error: "project not found", code: "not_found" });
    try { auditLog(req, "scope_snapshot.create.requested", { project_id: project.project_id, actor: actor.principal_id }); }
    catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "scope_snapshots" }); }
    try {
      const snapshot = platformKernel.createScopeSnapshot({ ...req.body, project_id: project.project_id, created_by: authenticatedUser(req), source: "dashboard" });
      let auditStatus = "complete";
      try { auditLog(req, "scope_snapshot.create", { snapshot_id: snapshot.snapshot_id, digest: snapshot.digest, target_count: snapshot.target_count, actor: actor.principal_id }); }
      catch { auditStatus = "degraded"; }
      res.json({ ok: true, snapshot, audit_status: auditStatus });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "scope_snapshots" }); }
  });

  app.post("/api/scope-guard/evaluate", (req, res) => {
    const actor = principal(req, res);
    if (!actor || !requireIdentityPermission(req, res, "scopes.read")) return;
    const snapshot = platformKernel.getScopeSnapshot(req.body?.snapshot_id);
    if (!snapshot || !accessibleProject(actor, snapshot.project_id, "read")) return res.status(404).json({ ok: false, error: "scope snapshot not found", code: "not_found" });
    try {
      const decision = platformKernel.evaluateScope(req.body?.snapshot_id, req.body || {});
      auditLog(req, "scope_guard.evaluate", { snapshot_id: decision.snapshot_id, decision_digest: decision.decision_digest, ok: decision.ok, reason: decision.reason, actor: authenticatedUser(req) });
      res.json({ ok: true, decision });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "scope_guard" }); }
  });
}

module.exports = { registerScopeSnapshotRoutes };
