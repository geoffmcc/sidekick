const { canonicalizeProjectName } = require("../core/project-identity");

function authorizeMemoryScope(req, res, projectAccess, access, requestedProject) {
  const principalId = req.authPrincipal?.principal_id;
  if (!principalId) {
    res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
    return null;
  }
  let project = null;
  try { if (requestedProject) project = canonicalizeProjectName(requestedProject); }
  catch {
    res.status(400).json({ ok: false, error: "invalid project", code: "invalid_request" });
    return null;
  }
  const scopes = req.authPrincipal.scopes;
  const delegationId = req.authPrincipal.delegation_id || req.authPrincipal.delegationId || null;
  const global = projectAccess.hasGlobalMemoryAccess(principalId, access, scopes, delegationId);
  if (!project && !global) {
    res.status(400).json({ ok: false, error: "project is required", code: "project_scope_required" });
    return null;
  }
  if (project && !projectAccess.hasProjectAccess(principalId, project, access, scopes, delegationId)) {
    res.status(403).json({ ok: false, error: "project access denied", code: "project_access_denied" });
    return null;
  }
  return { project, global };
}

function authorizeSyncMemoryScope(req, res, { requireIdentityPermission, projectAccess, permission, access, project }) {
  // Explicit project transfers use the same memory permission and membership
  // boundary as the canonical sync tools. Global transfers stay administrator
  // controlled through the dedicated sync permission.
  if (!project && !requireIdentityPermission(req, res, permission)) return null;
  return authorizeMemoryScope(req, res, projectAccess, access, project);
}

function registerSyncRoutes({ app, dbStore, requireIdentityPermission, projectAccess, auditLog, recordIdentityAudit, errorResponse }) {
  app.get("/api/sync/identity", (req, res) => {
    if (!requireIdentityPermission(req, res, "sync.read")) return;
    try {
      res.json({ ok: true, machine_id: dbStore.getMachineId(), user_id: dbStore.getUserId() });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "sync" }); }
  });

  app.post("/api/sync/identity", (req, res) => {
    if (!requireIdentityPermission(req, res, "sync.manage")) return;
    try {
      const { user_id } = req.body || {};
      if (!user_id || typeof user_id !== "string") return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "sync" });
      if (typeof recordIdentityAudit !== "function") return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "sync" });
      try { auditLog(req, "sync_identity.update.requested", {}); }
      catch { return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "sync" }); }
      try {
        dbStore.setUserId(user_id, {
          audit: details => recordIdentityAudit("dashboard.sync.identity.updated", null, req.authPrincipal.principal_id, details),
        });
      } catch {
        return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "sync" });
      }
      let auditStatus = "complete";
      try { auditLog(req, "sync_set_user_id", { user_id }); }
      catch { auditStatus = "degraded"; }
      res.json({ ok: true, user_id, audit_status: auditStatus });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "sync" }); }
  });

  app.get("/api/sync/export", (req, res) => {
    try {
      const { project, since, include_disabled } = req.query;
      const scope = authorizeSyncMemoryScope(req, res, { requireIdentityPermission, projectAccess, permission: "sync.read", access: "read", project });
      if (!scope) return;
      const options = {};
      if (scope.project) options.project = scope.project;
      if (since) options.since = since;
      if (include_disabled === "false") options.includeDisabled = false;
      const data = dbStore.exportForSync(options);
      auditLog(req, "sync_export", { count: data.count, project, since });
      res.json({ ok: true, data });
    } catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "sync" }); }
  });

  app.post("/api/sync/import", (req, res) => {
    try {
      const { data, strategy, preserve_ids } = req.body || {};
      const scope = authorizeSyncMemoryScope(req, res, { requireIdentityPermission, projectAccess, permission: "sync.manage", access: "write", project: req.body?.project });
      if (!scope) return;
      if (!data || !Array.isArray(data.memories)) {
        return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "sync" });
      }
      if (typeof recordIdentityAudit !== "function") {
        return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "sync" });
      }
      try {
        auditLog(req, "sync_import.requested", { project: scope.project, strategy: strategy || "newest" });
      } catch {
        return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "sync" });
      }
      let identityAuditWritten = false;
      let identityAuditFailed = false;
      const result = dbStore.importFromSync(data, {
        strategy: strategy || "newest",
        preserveIds: preserve_ids === true,
        ...((scope.project || !scope.global) ? { projectScope: scope.project } : {}),
        audit: summary => {
          try {
            recordIdentityAudit("dashboard.sync.imported", null, req.authPrincipal.principal_id, {
              project: scope.project,
              strategy: strategy || "newest",
              ...summary,
            });
            identityAuditWritten = true;
          } catch (error) {
            identityAuditFailed = true;
            throw error;
          }
        },
      });
      if (identityAuditFailed) {
        return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "sync" });
      }
      if (!identityAuditWritten) return errorResponse(req, res, null, { status: 503, code: "sync_unavailable", component: "sync" });
      let auditStatus = "complete";
      try { auditLog(req, "sync_import", { imported: result.imported, conflicts: result.conflicts, strategy }); }
      catch { auditStatus = "degraded"; }
      res.json({ ok: true, ...result, audit_status: auditStatus });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "sync" }); }
  });

  app.get("/api/sync/diff", (req, res) => {
    try {
       const scope = authorizeSyncMemoryScope(req, res, { requireIdentityPermission, projectAccess, permission: "sync.read", access: "read", project: req.query.project });
       if (!scope) return;
       if (!req.query.since) return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "sync" });
      res.json({ ok: true, ...dbStore.getSyncDiff(req.query.since, scope.project ? { project: scope.project } : {}) });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "sync" }); }
  });
}

module.exports = { registerSyncRoutes };
