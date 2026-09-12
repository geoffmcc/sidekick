function registerComputeReadRoutes({ app, compute, computeInstallInfo, errorResponse }) {
  app.get("/api/compute", (req, res) => {
    try { compute.initialize(); res.json({ ok: true, overview: compute.overview() }); }
    catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });

  app.get("/api/compute/workers", (req, res) => {
    try {
      compute.initialize();
      res.json({ ok: true, workers: compute.workerManager.listWorkers(req.query || {}), telemetry: compute.workerManager.listWorkerTelemetry(req.query || {}), stats: compute.workerManager.getWorkerStats() });
    } catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });

  app.get("/api/compute/jobs", (req, res) => {
    try {
      compute.initialize();
      res.json({ ok: true, jobs: compute.jobManager.listJobs({ status: req.query.status, jobType: req.query.jobType || req.query.job_type, project: req.query.project, workerId: req.query.workerId || req.query.worker_id, capability: req.query.capability, limit: req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : 50 }), stats: compute.jobManager.getJobStats() });
    } catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });

  app.get("/api/compute/jobs/:jobId", (req, res) => {
    try {
      compute.initialize();
      const job = compute.jobManager.getJob(req.params.jobId);
      if (!job) return errorResponse(req, res, null, { status: 404, code: "not_found", component: "compute", publicMessage: "job not found" });
      res.json({ ok: true, job, attempts: compute.jobManager.listAttempts(req.params.jobId), artifacts: compute.jobManager.listArtifacts(req.params.jobId) });
    } catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });

  app.get("/api/compute/install", (req, res) => {
    try { res.json({ ok: true, install: computeInstallInfo(req) }); }
    catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });
}

module.exports = { registerComputeReadRoutes };
