"use strict";

function registerEvolveRoutes({
  app,
  evolveDashboardAction,
  authenticatedUser,
  dbStore,
  shapeExecution,
  requireAttributedActor,
  crypto,
  callDashboardTool,
  dashboardExecutionMetadata,
  redactSensitive,
  auditLog,
  dynamicTools,
}) {
  app.post("/api/evolve/analyze", (req, res) => evolveDashboardAction(req, res, "analyze"));
  app.post("/api/evolve/:id/validate", (req, res) => evolveDashboardAction(req, res, "validate"));
  // Approval must carry the authenticated principal, never the dashboard actor.
  app.post("/api/evolve/:id/approve", (req, res) =>
    evolveDashboardAction(req, res, "approve", { approver: authenticatedUser(req) || undefined }));
  app.post("/api/evolve/:id/promote", (req, res) => evolveDashboardAction(req, res, "promote"));
  app.post("/api/evolve/:id/reject", (req, res) => evolveDashboardAction(req, res, "reject"));
  app.post("/api/evolve/:id/deprecate", (req, res) => evolveDashboardAction(req, res, "deprecate"));
  app.post("/api/evolve/:id/feedback", (req, res) => evolveDashboardAction(req, res, "feedback"));

  app.get("/api/evolve/executions", (req, res) => {
    const executions = dbStore.listGeneratedToolExecutions({ capabilityId: req.query.capability_id, limit: req.query.limit }).map(shapeExecution);
    res.json({ ok: true, executions });
  });

  app.get("/api/evolve/executions/:executionId", (req, res) => {
    const execution = dbStore.getGeneratedToolExecution(req.params.executionId);
    if (!execution) return res.status(404).json({ ok: false, error: "Execution not found" });
    res.json({ ok: true, execution: shapeExecution(execution) });
  });

  app.post("/api/evolve/:id/run", (req, res) => {
    // Generated capabilities execute model-authored code on the host and need
    // the same authenticated attribution as approval and promotion.
    const actor = requireAttributedActor(req, res, "Running a generated tool");
    if (!actor) return;
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
              finalSummary: redactSensitive(result.content?.[0]?.text || result.code || "generated tool dispatch failed"),
              errorCategory: result.code || "error",
              successCriteriaSatisfied: false,
            });
          }
        }
      } catch (error) {
        dbStore.updateGeneratedToolExecution(executionId, {
          state: "failed",
          completedAt: new Date().toISOString(),
          finalSummary: redactSensitive(error.message),
          errorCategory: "error",
          successCriteriaSatisfied: false,
        });
      }
    });
    auditLog(req, "evolve.run", { id: cap.id, execution_id: executionId });
    res.json({ ok: true, execution_id: executionId, execution: shapeExecution(dbStore.getGeneratedToolExecution(executionId)) });
  });

  app.post("/api/evolve/executions/:executionId/cancel", (req, res) => {
    const execution = dynamicTools.cancelExecution(req.params.executionId);
    if (!execution) return res.status(404).json({ ok: false, error: "Execution not found" });
    auditLog(req, "evolve.cancel", { execution_id: execution.id });
    res.json({ ok: true, execution: shapeExecution(execution) });
  });

  app.get("/api/evolve/executions/:executionId/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = execution => {
      if (execution.id !== req.params.executionId) return;
      res.write(`event: execution\ndata: ${JSON.stringify(shapeExecution(execution))}\n\n`);
    };
    const current = dbStore.getGeneratedToolExecution(req.params.executionId);
    if (current) res.write(`event: execution\ndata: ${JSON.stringify(shapeExecution(current))}\n\n`);
    const off = dynamicTools.onExecutionEvent(send);
    req.on("close", off);
  });
}

module.exports = { registerEvolveRoutes };
