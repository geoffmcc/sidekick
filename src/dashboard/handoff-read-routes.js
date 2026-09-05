const authorization = require("../core/authorization");

function registerHandoffReadRoutes({ app, dbStore, errorResponse }) {
  function canRead(req, handoff) {
    const principal = req.authPrincipal;
    if (!principal?.principal_id || !handoff) return false;
    if (handoff.owner_principal_id === principal.principal_id || handoff.created_by_principal_id === principal.principal_id) return true;
    return authorization.authorize({
      principalId: principal.principal_id,
      permission: "principals.manage",
      credentialScopes: principal.scopes,
      delegationId: principal.delegation_id || null,
    }).ok;
  }

  function requireHandoff(req, res) {
    const handoff = dbStore.getHandoff(req.params.id);
    if (!handoff || !canRead(req, handoff)) {
      res.status(404).json({ ok: false, error: "Handoff not found" });
      return null;
    }
    return handoff;
  }

  app.get("/api/handoffs", (req, res) => {
    try {
      const handoffs = dbStore.listHandoffs({ project: req.query.project, includeArchived: req.query.include_archived === "true", limit: Math.min(Number(req.query.limit) || 50, 500) });
      res.json({ ok: true, handoffs: handoffs.filter(handoff => canRead(req, handoff)) });
    } catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "handoffs" }); }
  });

  app.get("/api/handoffs/:id/readiness", (req, res) => {
    try {
      if (!requireHandoff(req, res)) return;
      const readiness = dbStore.getHandoffReadiness(req.params.id, { recipient: req.query.recipient });
      if (readiness.status === "invalid" && readiness.reasons?.includes("handoff not found")) return res.status(404).json({ ok: false, readiness });
      res.json({ ok: true, readiness });
    } catch (error) { errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "handoffs" }); }
  });

  app.get("/api/handoffs/:id/start-here", (req, res) => {
    try {
      if (!requireHandoff(req, res)) return;
      const projection = dbStore.getHandoffReceiverProjection(req.params.id, { recipient: req.query.recipient });
      if (!projection) return res.status(404).json({ ok: false, error: "Handoff not found" });
      res.json({ ok: true, projection });
    } catch (error) { errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "handoffs" }); }
  });

  app.get("/api/handoffs/:id/preflight", (req, res) => {
    try {
      if (!requireHandoff(req, res)) return;
      const preflight = dbStore.getHandoffResumePreflight(req.params.id, { recipient: req.query.recipient, simulate: req.query.simulate === "true" });
      if (preflight.status === "invalid") return res.status(404).json({ ok: false, preflight });
      res.json({ ok: true, preflight });
    } catch (error) { errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "handoffs" }); }
  });

  app.get("/api/handoffs/:id/events", (req, res) => {
    try {
      if (!requireHandoff(req, res)) return;
      res.json({ ok: true, handoff_id: req.params.id, events: dbStore.listHandoffEvents(req.params.id, req.query.limit || 100), integrity: dbStore.verifyHandoffEventChain(req.params.id) });
    } catch (error) { errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "handoffs" }); }
  });

  app.get("/api/handoffs/:id", (req, res) => {
    try {
      const handoff = requireHandoff(req, res);
      if (!handoff) return;
      const memories = dbStore.searchMemories({ project: handoff.project, includeDisabled: true, limit: 200 }).filter(memory => memory.source_ref === handoff.id || memory.metadata?.handoff_id === handoff.id);
      res.json({ ok: true, handoff, memories });
    } catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "handoffs" }); }
  });

  app.get("/api/memories/:id/evidence", (req, res) => {
    try {
      const memory = dbStore.getMemoryById(req.params.id, { includeDisabled: true });
      if (!memory) return res.status(404).json({ ok: false, error: "Memory not found" });
      const handoff = memory.source_ref ? dbStore.getHandoff(memory.source_ref) : null;
      const principal = req.authPrincipal;
      const authorized = principal?.principal_id && (handoff
        ? canRead(req, handoff)
        : authorization.authorize({
          principalId: principal.principal_id,
          permission: "principals.manage",
          credentialScopes: principal.scopes,
          delegationId: principal.delegation_id || null,
        }).ok);
      if (!authorized) return res.status(404).json({ ok: false, error: "Memory not found" });
      res.json({ ok: true, memory, evidence: dbStore.getMemoryEvidence(req.params.id) });
    } catch (error) { errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "memories" }); }
  });
}

module.exports = { registerHandoffReadRoutes };
