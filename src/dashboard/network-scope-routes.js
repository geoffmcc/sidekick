"use strict";

const scopes = require("../security/network-scopes");
const networkPolicy = require("../security/network-scope");

function registerNetworkScopeRoutes({ app, authenticatedUser, requireIdentityAdministrator, auditLog, logError, errorResponse }) {
  function read(req, res) {
    if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" });
    try { return res.json({ ok: true, scopes: scopes.list({ state: req.query.state, limit: req.query.limit }) }); }
    catch (error) { return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "network_scope" }); }
  }
  function mutate(req, res, operation) {
    if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" });
    if (!requireIdentityAdministrator(req, res)) return;
    try {
      const actor = authenticatedUser(req); let result;
      if (operation === "validate") result = scopes.validate(req.body || {});
      else if (operation === "create") result = scopes.create(req.body || {}, actor);
      else if (operation === "update") result = scopes.update(req.params.scopeId, req.body || {}, actor);
      else if (operation === "state") result = scopes.setState(req.params.scopeId, req.body?.state, actor);
      else if (operation === "diagnose") {
        const scope = scopes.get(req.body?.network_scope, req.body?.revision);
        if (!scope) return res.status(404).json({ ok: false, error: "network scope not found" });
        result = { scope_id: scope.scope_id, revision: scope.revision, digest: scope.digest, decision: networkPolicy.decision(scope, req.body || {}) };
      }
      auditLog(req, `network_scope.${operation}`, { scope_id: result?.scope_id || req.params.scopeId || null, revision: result?.revision || null, digest: result?.digest || null }, actor);
      return res.json({ ok: true, scope: operation === "diagnose" ? undefined : result, diagnostic: operation === "diagnose" ? result : undefined });
     } catch (error) { try { auditLog(req, `network_scope.${operation}.denied`, { scope_id: req.params.scopeId || null, reason: "invalid_request" }, authenticatedUser(req)); } catch {} return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "network_scope" }); }
  }
  app.get("/api/network-scopes", read);
  app.get("/api/network-scopes/:scopeId", (req, res) => { if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" }); const scope = scopes.get(req.params.scopeId, req.query.revision); return scope ? res.json({ ok: true, scope, references: scopes.references(scope.scope_id) }) : res.status(404).json({ ok: false, error: "network scope not found" }); });
  app.post("/api/network-scopes/validate", (req, res) => mutate(req, res, "validate"));
  app.post("/api/network-scopes", (req, res) => mutate(req, res, "create"));
  app.put("/api/network-scopes/:scopeId", (req, res) => mutate(req, res, "update"));
  app.post("/api/network-scopes/:scopeId/state", (req, res) => mutate(req, res, "state"));
  app.post("/api/network-scopes/diagnose", (req, res) => mutate(req, res, "diagnose"));
}

module.exports = { registerNetworkScopeRoutes };
