function registerComputeReadRoutes({ app, compute, computeInstallInfo }) {
  app.get("/api/compute", (req, res) => {
    try { compute.initialize(); res.json({ ok: true, overview: compute.overview() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/compute/workers", (req, res) => {
    try {
      compute.initialize();
      res.json({ ok: true, workers: compute.workerManager.listWorkers(req.query || {}), telemetry: compute.workerManager.listWorkerTelemetry(req.query || {}), stats: compute.workerManager.getWorkerStats() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/compute/jobs", (req, res) => {
    try {
      compute.initialize();
      res.json({ ok: true, jobs: compute.jobManager.listJobs({ status: req.query.status, jobType: req.query.jobType || req.query.job_type, project: req.query.project, workerId: req.query.workerId || req.query.worker_id, capability: req.query.capability, limit: req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : 50 }), stats: compute.jobManager.getJobStats() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/compute/jobs/:jobId", (req, res) => {
    try {
      compute.initialize();
      const job = compute.jobManager.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ ok: false, error: "job not found" });
      res.json({ ok: true, job, attempts: compute.jobManager.listAttempts(req.params.jobId), artifacts: compute.jobManager.listArtifacts(req.params.jobId) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/compute/install", (req, res) => {
    try { res.json({ ok: true, install: computeInstallInfo(req) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

module.exports = { registerComputeReadRoutes };
