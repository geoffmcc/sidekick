"use strict";

function registerEvolveRoutes({
  app,
  evolveDashboardAction,
  authenticatedUser,
  dbStore,
  shapeExecution,
  requireAttributedActor,
  requireIdentityPermission,
  hasIdentityPermission,
  crypto,
  callDashboardTool,
  dashboardExecutionMetadata,
  redactSensitive,
  auditLog,
  dynamicTools,
  logError,
  errorResponse,
}) {
  const guarded = (handler, component = "evolve") => (req, res) => {
    try {
      const result = handler(req, res);
      return result && typeof result.catch === "function"
        ? result.catch(error => errorResponse(req, res, error, { status: 500, code: "service_unavailable", component }))
        : result;
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component });
    }
  };

  app.post("/api/evolve/analyze", guarded((req, res) => evolveDashboardAction(req, res, "analyze")));
  app.post("/api/evolve/:id/validate", guarded((req, res) => evolveDashboardAction(req, res, "validate")));
  // Approval must carry the authenticated principal, never the dashboard actor.
  app.post("/api/evolve/:id/approve", guarded((req, res) =>
    evolveDashboardAction(req, res, "approve", { approver: authenticatedUser(req) || undefined })));
  app.post("/api/evolve/:id/promote", guarded((req, res) => evolveDashboardAction(req, res, "promote")));
  app.post("/api/evolve/:id/reject", guarded((req, res) => evolveDashboardAction(req, res, "reject")));
  app.post("/api/evolve/:id/deprecate", guarded((req, res) => evolveDashboardAction(req, res, "deprecate")));
  app.post("/api/evolve/:id/feedback", guarded((req, res) => evolveDashboardAction(req, res, "feedback")));

  app.get("/api/evolve/executions", guarded((req, res) => {
    if (!requireIdentityPermission(req, res, "dashboard.operations.read")) return;
    const executions = dbStore.listGeneratedToolExecutions({ capabilityId: req.query.capability_id, limit: req.query.limit }).map(shapeExecution);
    res.json({ ok: true, executions });
  }));

  app.get("/api/evolve/executions/:executionId", guarded((req, res) => {
    if (!requireIdentityPermission(req, res, "dashboard.operations.read")) return;
    const execution = dbStore.getGeneratedToolExecution(req.params.executionId);
    if (!execution) return res.status(404).json({ ok: false, error: "Execution not found" });
    res.json({ ok: true, execution: shapeExecution(execution) });
  }));

  app.post("/api/evolve/:id/run", guarded((req, res) => {
    // Generated capabilities execute model-authored code on the host and need
    // the same authenticated attribution as approval and promotion.
    if (!requireIdentityPermission(req, res, "dashboard.operations.manage")) return;
    const actor = requireAttributedActor(req, res, "Running a generated tool");
    if (!actor) return;
    try { auditLog(req, "evolve.run.requested", { id: req.params.id }); }
    catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "evolve" }); }
    const cap = dbStore.getGeneratedCapability(req.params.id) || dbStore.getGeneratedCapabilityByName(req.params.id);
    if (!cap || !["trial", "active"].includes(cap.state)) return res.status(400).json({ ok: false, error: "Generated tool is not trial or active" });
    const executionId = `gte_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    const timeoutMs = Number(req.body?.timeout_ms || 0) || null;
    dbStore.createGeneratedToolExecution({
      id: executionId,
      capabilityId: cap.id,
      toolName: cap.name,
      state: "queued",
      source: "dashboard",
      args: req.body?.args || {},
      successCriteria: cap.successCriteria || "All generated workflow steps must complete successfully",
      timeoutMs,
    });
    setImmediate(async () => {
      try {
        const result = await callDashboardTool(cap.name, req.body?.args || {}, dashboardExecutionMetadata(req, actor, { executionId, timeoutMs }));
        // Error results must finalize rows the handler did not already close.
        if (result && result.isError) {
          const current = dbStore.getGeneratedToolExecution(executionId);
          if (current && ["queued", "running"].includes(current.state)) {
            dbStore.updateGeneratedToolExecution(executionId, {
              state: "failed",
              completedAt: new Date().toISOString(),
              finalSummary: "generated tool dispatch failed",
              errorCategory: result.code || "error",
              successCriteriaSatisfied: false,
            });
          }
        }
      } catch (error) {
        if (logError) logError(req.originalUrl, 500, error, "evolve", req.headers["user-agent"], req);
        dbStore.updateGeneratedToolExecution(executionId, {
          state: "failed",
          completedAt: new Date().toISOString(),
          finalSummary: "generated tool dispatch failed",
          errorCategory: "error",
          successCriteriaSatisfied: false,
        });
      }
    });
    let auditStatus = "complete";
    try { auditLog(req, "evolve.run", { id: cap.id, execution_id: executionId }); }
    catch { auditStatus = "degraded"; }
    res.json({ ok: true, execution_id: executionId, execution: shapeExecution(dbStore.getGeneratedToolExecution(executionId)), audit_status: auditStatus });
  }));

  app.post("/api/evolve/executions/:executionId/cancel", guarded((req, res) => {
    if (!requireIdentityPermission(req, res, "dashboard.operations.manage")) return;
    const actor = requireAttributedActor(req, res, "Cancelling a generated tool execution");
    if (!actor) return;
    try { auditLog(req, "evolve.cancel.requested", { execution_id: req.params.executionId, actor }); }
    catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "evolve" }); }
    const execution = dynamicTools.cancelExecution(req.params.executionId);
    if (!execution) return res.status(404).json({ ok: false, error: "Execution not found" });
    let auditStatus = "complete";
    try { auditLog(req, "evolve.cancel", { execution_id: execution.id, actor }); }
    catch { auditStatus = "degraded"; }
    res.json({ ok: true, execution: shapeExecution(execution), audit_status: auditStatus });
  }));

  app.get("/api/evolve/executions/:executionId/stream", guarded((req, res) => {
    if (!requireIdentityPermission(req, res, "dashboard.operations.read")) return;
    if (typeof hasIdentityPermission !== "function") return res.status(503).json({ ok: false, error: "Authorization unavailable", code: "authorization_unavailable" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let ended = false;
    let authorizationPoll = null;
    let off = () => {};
    const close = () => {
      if (ended) return;
      ended = true;
      if (authorizationPoll) clearInterval(authorizationPoll);
      off();
      res.end();
    };
    const send = execution => {
      if (ended || execution.id !== req.params.executionId) return;
      if (!hasIdentityPermission(req, "dashboard.operations.read")) return close();
      res.write(`event: execution\ndata: ${JSON.stringify(shapeExecution(execution))}\n\n`);
    };
    const current = dbStore.getGeneratedToolExecution(req.params.executionId);
    if (current) send(current);
    if (ended) return;
    off = dynamicTools.onExecutionEvent(send);
    authorizationPoll = setInterval(() => {
      if (!hasIdentityPermission(req, "dashboard.operations.read")) close();
    }, 1000);
    if (typeof authorizationPoll.unref === "function") authorizationPoll.unref();
    req.on("close", close);
  }));
}

module.exports = { registerEvolveRoutes };
