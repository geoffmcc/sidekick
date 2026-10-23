"use strict";

function registerMemoryMutationRoutes({ app, dbStore, projectAccess, requireIdentityAdministrator, auditLog, recordIdentityAudit, errorResponse }) {
  app.post("/api/memories/:id/enable", (req, res) => {
    try {
      const principal = req.authPrincipal;
      if (!principal?.principal_id) return res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      const memory = dbStore.getMemoryById(req.params.id, { includeDisabled: true });
      if (!memory) return errorResponse(req, res, null, { status: 404, code: "not_found", component: "memory" });
      if (!projectAccess.hasProjectAccess(principal.principal_id, memory.project, "write", principal.scopes, principal.delegation_id || principal.delegationId || null)) {
        auditLog(req, "memory_enable", { id: req.params.id, ok: false, denied: true });
        return errorResponse(req, res, null, { status: 404, code: "not_found", component: "memory" });
      }
      if (typeof recordIdentityAudit !== "function") return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "memory" });
      try { auditLog(req, "memory_enable.requested", { id: req.params.id }); }
      catch { return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "memory" }); }
      let identityAuditFailed = false;
      let success;
      try {
        success = dbStore.enableMemory(req.params.id, {
          audit: details => {
            try { recordIdentityAudit("dashboard.memory.enabled", null, principal.principal_id, details); }
            catch (error) { identityAuditFailed = true; throw error; }
          },
        });
      } catch (error) {
        if (identityAuditFailed) return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "memory" });
        throw error;
      }
      if (!success) return errorResponse(req, res, null, { status: 404, code: "not_found", component: "memory" });
      let auditStatus = "complete";
      try { auditLog(req, "memory_enable", { id: req.params.id, ok: true }); }
      catch { auditStatus = "degraded"; }
      res.json({ ok: true, audit_status: auditStatus });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memory" });
    }
  });

  app.post("/api/memories/expire", (req, res) => {
    try {
      if (!requireIdentityAdministrator(req, res)) return;
      const { stale_days } = req.body || {};
      if (stale_days !== undefined && (!Number.isFinite(Number(stale_days)) || Number(stale_days) < 0)) {
        return errorResponse(req, res, null, { status: 400, code: "invalid_request", component: "memory" });
      }
      const principalId = req.authPrincipal?.principal_id;
      if (!principalId || typeof recordIdentityAudit !== "function") return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "memory" });
      try { auditLog(req, "memory_expire.requested", { stale_days }); }
      catch { return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "memory" }); }
      let identityAuditFailed = false;
      let result;
      try {
        result = dbStore.expireStaleMemories({
          staleDays: stale_days,
          audit: details => {
            try { recordIdentityAudit("dashboard.memory.expired_stale", null, principalId, { stale_days, ...details }); }
            catch (error) { identityAuditFailed = true; throw error; }
          },
        });
      } catch (error) {
        if (identityAuditFailed) return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "memory" });
        throw error;
      }
      let auditStatus = "complete";
      try { auditLog(req, "memory_expire", { expired: result.expired, stale_days }); }
      catch { auditStatus = "degraded"; }
      res.json({ ok: true, ...result, audit_status: auditStatus });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memory" });
    }
  });
}

module.exports = { registerMemoryMutationRoutes };
