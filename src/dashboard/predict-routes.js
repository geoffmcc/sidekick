"use strict";

const PREDICTIONS_READ_PERMISSION = "predictions.read";

function registerPredictRoutes({ app, predictEngine, governedDashboardMutation, projectAccess, requireIdentityPermission, errorResponse }) {
  const guarded = (handler, component) => (req, res) => {
    try {
      return handler(req, res);
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component });
    }
  };

  function requirePermission(req, res, permission) {
    if (!req.authPrincipal?.principal_id) {
      res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      return false;
    }
    if (typeof requireIdentityPermission !== "function") {
      res.status(503).json({ ok: false, error: "authorization service unavailable", code: "authorization_unavailable" });
      return false;
    }
    return requireIdentityPermission(req, res, permission);
  }

  function canReadPrediction(req, prediction) {
    const principal = req.authPrincipal;
    return Boolean(principal?.principal_id && projectAccess?.hasProjectPermission?.(
      principal.principal_id, prediction?.project, PREDICTIONS_READ_PERMISSION, "read", principal.scopes,
    ));
  }

  app.get("/api/predict/status", guarded((req, res) => {
    if (!requirePermission(req, res, "dashboard.operations.read")) return;
    res.json(predictEngine.engineStatus());
  }, "predict"));

  app.get("/api/predict", guarded((req, res) => {
    if (!requirePermission(req, res, PREDICTIONS_READ_PERMISSION)) return;
    const { status, type, project, session_id, task_id, confidence, limit, offset } = req.query || {};
    const principal = req.authPrincipal;
    const globalAccess = Boolean(projectAccess?.hasGlobalProjectAccess?.(principal.principal_id, principal.scopes));
    let accessibleProjects;
    if (project) {
      if (!canReadPrediction(req, { project })) return res.status(404).json({ ok: false, error: "Not found", code: "not_found" });
    } else if (!globalAccess) {
      accessibleProjects = projectAccess?.listAccessibleProjectsForPermission?.(principal.principal_id, PREDICTIONS_READ_PERMISSION, principal.scopes) || [];
    }
    const predictions = predictEngine.listPredictions({
      status, type, project, session_id, task_id, confidence,
      ...(!project && accessibleProjects ? { projects: accessibleProjects.map(row => row.project_id) } : {}),
      limit: parseInt(limit || "20", 10), offset: parseInt(offset || "0", 10),
    });
    res.json({ ok: true, count: predictions.length, predictions });
  }, "predict"));

  app.get("/api/predict/:id", guarded((req, res) => {
    if (!requirePermission(req, res, PREDICTIONS_READ_PERMISSION)) return;
    const pred = predictEngine.getPrediction(req.params.id);
    if (!pred) return res.status(404).json({ ok: false, error: "Not found" });
    if (!canReadPrediction(req, pred)) return res.status(404).json({ ok: false, error: "Not found", code: "not_found" });
    const evidence = predictEngine.getPredictionEvidence(req.params.id);
    const feedback = predictEngine.getPredictionFeedback(req.params.id);
    res.json({ ok: true, prediction: pred, evidence, feedback });
  }, "predict"));

  app.post("/api/predict/analyze", (req, res) => governedDashboardMutation(req, res, "predict", { action: "analyze", ...(req.body || {}), maxAge: req.body?.maxAge || "7d" }, "predict.analyze"));

  app.get("/api/predict/maintenance/purge-preview", guarded((req, res) => {
    if (!requirePermission(req, res, "dashboard.operations.read")) return;
    const retention = req.query.retention_days === undefined
      ? undefined : Number(req.query.retention_days);
    if (!predictEngine.isValidRetentionDays(retention)) {
      return res.status(400).json({ ok: false, error: "retention_days must be a non-negative number" });
    }
    res.json(predictEngine.purgePreview({
      retention_days: retention,
      purge_legacy: req.query.purge_legacy === "true",
    }));
  }, "predict"));

  app.post("/api/predict/maintenance/purge", (req, res) => governedDashboardMutation(req, res, "predict", { action: "purge", ...(req.body || {}) }, "predict.purge"));
  app.get("/api/predict/maintenance/diagnose", guarded((req, res) => {
    if (!requirePermission(req, res, "dashboard.operations.read")) return;
    return res.json(predictEngine.diagnose());
  }, "predict"));
  app.post("/api/predict/:id/feedback", (req, res) => governedDashboardMutation(req, res, "predict", { action: "feedback", id: req.params.id, ...(req.body || {}) }, "predict.feedback"));
  app.post("/api/predict/:id/outcome", (req, res) => governedDashboardMutation(req, res, "predict", { action: "outcome", id: req.params.id, ...(req.body || {}) }, "predict.outcome"));
  app.post("/api/predict/:id/dismiss", (req, res) => governedDashboardMutation(req, res, "predict", { action: "dismiss", id: req.params.id }, "predict.dismiss"));

  app.get("/api/predict/:id/explain", guarded((req, res) => {
    if (!requirePermission(req, res, PREDICTIONS_READ_PERMISSION)) return;
    const pred = predictEngine.getPrediction(req.params.id);
    if (!pred) return res.status(404).json({ ok: false, error: "Not found" });
    if (!canReadPrediction(req, pred)) return res.status(404).json({ ok: false, error: "Not found", code: "not_found" });
    const evidence = predictEngine.getPredictionEvidence(req.params.id);
    res.json({
      ok: true,
      prediction_id: pred.id,
      type: pred.type,
      subject: pred.subject,
      explanation: pred.explanation,
      probability: pred.probability,
      confidence: pred.confidence,
      score_breakdown: pred.score_breakdown,
      observation_count: pred.observation_count,
      evidence: evidence.map(e => ({
        source_type: e.source_type, source_id: e.source_id,
        summary: e.summary, timestamp: e.source_timestamp,
      })),
      created_at: pred.created_at, expires_at: pred.expires_at, rule_version: pred.rule_version,
    });
  }, "predict"));

  app.post("/api/predict/migrate", (req, res) => governedDashboardMutation(req, res, "predict", { action: "migrate" }, "predict.migrate"));
}

module.exports = { registerPredictRoutes, PREDICTIONS_READ_PERMISSION };
