"use strict";

const scopes = require("../security/network-scopes");
const networkPolicy = require("../security/network-scope");

function registerNetworkScopeRoutes({ app, authenticatedUser, requireIdentityPermission, auditLog, logError, errorResponse, scopeRegistry = scopes }) {
  function read(req, res) {
    if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" });
    if (!requireIdentityPermission(req, res, "network_scopes.read")) return;
    try { return res.json({ ok: true, scopes: scopes.list({ state: req.query.state, limit: req.query.limit }) }); }
    catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "network_scope" }); }
  }
  function mutate(req, res, operation) {
    if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" });
    if (!requireIdentityPermission(req, res, "network_scopes.manage")) return;
    const actor = authenticatedUser(req);
    const isMutation = ["create", "update", "state"].includes(operation);
    if (isMutation) {
      try { auditLog(req, `network_scope.${operation}.requested`, { scope_id: req.params.scopeId || null }, actor); }
      catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "network_scope" }); }
    }
    try {
      let result;
      if (operation === "validate") result = scopeRegistry.validate(req.body || {});
      else if (operation === "create") result = scopeRegistry.create(req.body || {}, actor);
      else if (operation === "update") result = scopeRegistry.update(req.params.scopeId, req.body || {}, actor);
      else if (operation === "state") result = scopeRegistry.setState(req.params.scopeId, req.body?.state, actor);
      else if (operation === "diagnose") {
        const scope = scopeRegistry.get(req.body?.network_scope, req.body?.revision);
        if (!scope) return res.status(404).json({ ok: false, error: "network scope not found" });
        result = { scope_id: scope.scope_id, revision: scope.revision, digest: scope.digest, decision: networkPolicy.decision(scope, req.body || {}) };
      }
      let auditStatus = "complete";
      try { auditLog(req, `network_scope.${operation}`, { scope_id: result?.scope_id || req.params.scopeId || null, revision: result?.revision || null, digest: result?.digest || null }, actor); }
      catch { if (isMutation) auditStatus = "degraded"; else throw new Error("audit unavailable"); }
      return res.json({ ok: true, scope: operation === "diagnose" ? undefined : result, diagnostic: operation === "diagnose" ? result : undefined, ...(isMutation ? { audit_status: auditStatus } : {}) });
     } catch (error) { try { auditLog(req, `network_scope.${operation}.denied`, { scope_id: req.params.scopeId || null, reason: "invalid_request" }, actor); } catch {} return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "network_scope" }); }
  }
  app.get("/api/network-scopes", read);
  app.get("/api/network-scopes/:scopeId", (req, res) => { if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" }); if (!requireIdentityPermission(req, res, "network_scopes.read")) return; const scope = scopes.get(req.params.scopeId, req.query.revision); return scope ? res.json({ ok: true, scope, references: scopes.references(scope.scope_id) }) : res.status(404).json({ ok: false, error: "network scope not found" }); });
  app.post("/api/network-scopes/validate", (req, res) => mutate(req, res, "validate"));
  app.post("/api/network-scopes", (req, res) => mutate(req, res, "create"));
  app.put("/api/network-scopes/:scopeId", (req, res) => mutate(req, res, "update"));
  app.post("/api/network-scopes/:scopeId/state", (req, res) => mutate(req, res, "state"));
  app.post("/api/network-scopes/diagnose", (req, res) => mutate(req, res, "diagnose"));
}

module.exports = { registerNetworkScopeRoutes };
