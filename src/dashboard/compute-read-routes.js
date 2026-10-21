function registerComputeReadRoutes({ app, compute, computeInstallInfo, requireIdentityPermission, projectAccess, platformKernel, errorResponse }) {
  function getProjectScope(req, res) {
    const principalId = req.authPrincipal?.principal_id;
    const delegationId = req.authPrincipal?.delegation_id || req.authPrincipal?.delegationId || null;
    if (!principalId) { res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" }); return undefined; }
    const projectId = req.query.project || req.query.project_id;
    if (!projectId) {
      if (projectAccess.hasGlobalProjectAccess(principalId, req.authPrincipal.scopes, delegationId)) return null;
      res.status(400).json({ ok: false, error: "project is required for compute job access", code: "project_scope_required" });
      return undefined;
    }
    let project;
    try { project = platformKernel.getProject(projectId); } catch {}
    if (!project || project.state !== "active" || !projectAccess.hasProjectAccess(principalId, project.project_id, "read", req.authPrincipal.scopes, delegationId)) {
      res.status(404).json({ ok: false, error: "project not found", code: "not_found" });
      return undefined;
    }
    return project.project_id;
  }

  app.get("/api/compute", (req, res) => {
    if (!requireIdentityPermission(req, res, "compute.nodes.read") || !requireIdentityPermission(req, res, "compute.jobs.read")) return;
    try { compute.initialize(); res.json({ ok: true, overview: compute.overview() }); }
    catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });

  app.get("/api/compute/workers", (req, res) => {
    if (!requireIdentityPermission(req, res, "compute.nodes.read")) return;
    try {
      compute.initialize();
      res.json({ ok: true, workers: compute.workerManager.listWorkers(req.query || {}), telemetry: compute.workerManager.listWorkerTelemetry(req.query || {}), stats: compute.workerManager.getWorkerStats() });
    } catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });

  app.get("/api/compute/jobs", (req, res) => {
    if (!requireIdentityPermission(req, res, "compute.jobs.read")) return;
    const project = getProjectScope(req, res);
    if (project === undefined) return;
    try {
      compute.initialize();
      res.json({ ok: true, jobs: compute.jobManager.listJobs({ status: req.query.status, jobType: req.query.jobType || req.query.job_type, project: project || undefined, workerId: req.query.workerId || req.query.worker_id, capability: req.query.capability, limit: req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : 50 }), stats: compute.jobManager.getJobStats(project ? { project } : undefined) });
    } catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });

  app.get("/api/compute/jobs/:jobId", (req, res) => {
    if (!requireIdentityPermission(req, res, "compute.jobs.read")) return;
    try {
      compute.initialize();
      const job = compute.jobManager.getJob(req.params.jobId);
      if (!job) return errorResponse(req, res, null, { status: 404, code: "not_found", component: "compute", publicMessage: "job not found" });
      const principalId = req.authPrincipal?.principal_id;
      const delegationId = req.authPrincipal?.delegation_id || req.authPrincipal?.delegationId || null;
      if (!principalId) return res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      const allowed = job.project
        ? Boolean(platformKernel.getProject(job.project)?.state === "active" && projectAccess.hasProjectAccess(principalId, job.project, "read", req.authPrincipal.scopes, delegationId))
        : projectAccess.hasGlobalProjectAccess(principalId, req.authPrincipal.scopes, delegationId);
      if (!allowed) return errorResponse(req, res, null, { status: 404, code: "not_found", component: "compute", publicMessage: "job not found" });
      res.json({ ok: true, job, attempts: compute.jobManager.listAttempts(req.params.jobId), artifacts: compute.jobManager.listArtifacts(req.params.jobId) });
    } catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });

  app.get("/api/compute/install", (req, res) => {
    if (!requireIdentityPermission(req, res, "compute.nodes.read")) return;
    try { res.json({ ok: true, install: computeInstallInfo(req) }); }
    catch (e) { return errorResponse(req, res, e, { status: 500, code: "service_unavailable", component: "compute" }); }
  });
}

module.exports = { registerComputeReadRoutes };
