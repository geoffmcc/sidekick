"use strict";

const { createPermissionMiddleware } = require("../node/admin-api");

function createProjectJobScopeMiddleware({ projectAccess, platformKernel, compute }) {
  function projectIsActive(project) {
    if (!project) return false;
    try { return platformKernel.getProject(project)?.state === "active"; } catch { return false; }
  }

  return function requireJobScope(action) {
    return (req, res, next) => {
      const actor = req.authIdentity;
      if (!actor?.principal_id) return res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
      const delegation = actor.delegation_id || null;
      const global = () => projectAccess.hasGlobalProjectAccess(actor.principal_id, actor.scopes, delegation);
      const permitted = (project, access) => projectIsActive(project)
        && projectAccess.hasProjectMembership(actor.principal_id, project, access, actor.scopes, delegation);

      if (action === "list") {
        const project = req.query?.project || req.query?.project_id;
        if (!project) {
          if (global()) { req.authorizedComputeProject = null; return next(); }
          return res.status(400).json({ ok: false, error: "project is required for Compute job access", code: "project_scope_required" });
        }
        if (!permitted(project, "read")) return res.status(404).json({ ok: false, error: "project not found", code: "not_found" });
        req.authorizedComputeProject = project;
        return next();
      }

      if (action === "create") {
        const project = req.body?.project;
        if (!project) return global()
          ? next()
          : res.status(400).json({ ok: false, error: "project is required for Compute job creation", code: "project_scope_required" });
        if (!permitted(project, "write")) return res.status(404).json({ ok: false, error: "project not found", code: "not_found" });
        req.authorizedComputeProject = project;
        return next();
      }

      const job = compute.jobManager.getJob(req.params?.jobId);
      if (!job) return res.status(404).json({ ok: false, error: "job not found", code: "not_found" });
      const allowed = job.project
        ? permitted(job.project, action === "read" ? "read" : "write")
        : global();
      if (!allowed) return res.status(404).json({ ok: false, error: "job not found", code: "not_found" });
      req.authorizedComputeJob = job;
      next();
    };
  };
}

function createAtomicAuditMiddleware({ dbStore, identity }, eventType = "compute.admin.mutation") {
  return (req, res, next) => {
    const sendJson = res.json.bind(res);
    let responseBody;
    let hasResponse = false;
    res.json = body => { responseBody = body; hasResponse = true; return res; };

    try {
      dbStore.getDb().transaction(() => {
        next();
        if (!hasResponse) throw new Error("Compute admin mutation handler did not complete synchronously");
        if (res.statusCode >= 200 && res.statusCode < 300 && responseBody?.ok !== false) {
          const route = String(req.route?.path || req.path || "unknown").slice(0, 180);
          const resourceId = req.params?.jobId || req.params?.workerId
            || responseBody?.job?.jobId || responseBody?.job?.job_id
            || responseBody?.worker?.workerId || responseBody?.worker?.worker_id
            || responseBody?.tokenId || responseBody?.token?.tokenId || null;
          identity.recordAuditEvent(eventType, req.authIdentity.principal_id, req.authIdentity.principal_id, {
            method: req.method,
            route,
            resource_id: resourceId ? String(resourceId).slice(0, 160) : null,
            project_id: (req.authorizedComputeProject || req.query?.project || req.query?.project_id || req.body?.project)
              ? String(req.authorizedComputeProject || req.query?.project || req.query?.project_id || req.body?.project).slice(0, 160)
              : null,
          });
        }
      }).immediate();
      res.json = sendJson;
      return sendJson(responseBody);
    } catch (error) {
      res.json = sendJson;
      return res.status(500).json({ ok: false, error: "Compute administrative audit failed; the operation was rolled back", code: "audit_unavailable" });
    }
  };
}

function sendComputeHealthResponse(res, compute) {
  try {
    return res.json({ ok: true, overview: compute.overview() });
  } catch {
    return res.status(500).json({ ok: false, error: "Compute health check failed", code: "compute_health_unavailable" });
  }
}

function sendComputeAdminError(res, error, status = 400) {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code)
    ? error.code
    : "COMPUTE_ERROR";
  if (status >= 500) {
    return res.status(status).json({ ok: false, error: "Compute operation failed", code: "compute_operation_failed" });
  }
  const message = String(error?.message || "Compute error").replace(/(wksec_|enroll_)[A-Za-z0-9_-]+/g, "[REDACTED]");
  return res.status(status).json({ ok: false, error: message, code });
}

function registerComputeAdminRoutes({ app, express, authentication, authorization, identity, dbStore, projectAccess, platformKernel, compute, handlers }) {
  const requirePermission = permission => createPermissionMiddleware(
    { authentication, authorization, resourceType: "compute_admin", denialMessage: "Compute administration denied" },
    permission,
  );
  const audit = createAtomicAuditMiddleware({ dbStore, identity });
  const auditRead = createAtomicAuditMiddleware({ dbStore, identity }, "compute.admin.read");
  const requireJobScope = createProjectJobScopeMiddleware({ projectAccess, platformKernel, compute });
  const nodesRead = requirePermission("compute.nodes.read");
  const nodesManage = requirePermission("compute.nodes.manage");
  const jobsRead = requirePermission("compute.jobs.read");
  const jobsCreate = requirePermission("compute.jobs.create");
  const jobsCancel = requirePermission("compute.jobs.cancel");
  const jobsManage = requirePermission("compute.jobs.manage");
  const jobsRecover = requirePermission("compute.jobs.recover");
  const json = limit => express.json({ limit });

  const router = express.Router();
  router.get("/workers", nodesRead, auditRead, handlers.listWorkers);
  router.get("/workers/:workerId", nodesRead, auditRead, handlers.getWorker);
  router.post("/workers/:workerId/disable", nodesManage, json("8kb"), audit, handlers.disableWorker);
  router.post("/workers/:workerId/enable", nodesManage, json("8kb"), audit, handlers.enableWorker);
  router.post("/workers/:workerId/revoke", nodesManage, json("8kb"), audit, handlers.revokeWorker);
  router.post("/workers/:workerId/credentials/rotate", nodesManage, json("8kb"), audit, handlers.rotateWorkerCredential);
  router.post("/jobs", jobsCreate, json("256kb"), requireJobScope("create"), audit, handlers.createJob);
  router.get("/jobs", jobsRead, requireJobScope("list"), auditRead, handlers.listJobs);
  router.get("/jobs/:jobId", jobsRead, requireJobScope("read"), auditRead, handlers.getJob);
  router.post("/jobs/:jobId/cancel", jobsCancel, json("8kb"), requireJobScope("write"), audit, handlers.cancelJob);
  router.post("/jobs/:jobId/retry", jobsManage, json("8kb"), requireJobScope("write"), audit, handlers.retryJob);
  router.post("/recover", jobsRecover, json("8kb"), handlers.recoverJobs);
  router.get("/health", nodesRead, jobsRead, auditRead, handlers.health);
  app.use("/compute/admin", router);

  const enrollmentRouter = express.Router();
  enrollmentRouter.post("/tokens", nodesManage, json("16kb"), audit, handlers.createEnrollmentToken);
  app.use("/compute/enrollment", enrollmentRouter);

  app.post("/compute/enrollment-tokens", nodesManage, json("16kb"), audit, handlers.createEnrollmentToken);
  app.post("/compute/jobs", jobsCreate, json("256kb"), requireJobScope("create"), audit, handlers.createJob);
  app.get("/compute/jobs", jobsRead, requireJobScope("list"), auditRead, handlers.listJobs);
  app.get("/compute/jobs/:jobId", jobsRead, requireJobScope("read"), auditRead, handlers.getJob);
  app.post("/compute/jobs/:jobId/cancel", jobsCancel, json("8kb"), requireJobScope("write"), audit, handlers.cancelJob);
  app.post("/compute/jobs/:jobId/retry", jobsManage, json("8kb"), requireJobScope("write"), audit, handlers.retryJob);
  app.post("/compute/recover", jobsRecover, json("8kb"), handlers.recoverJobs);
  app.get("/compute/health", nodesRead, jobsRead, auditRead, handlers.health);
}

module.exports = Object.freeze({ createProjectJobScopeMiddleware, createAtomicAuditMiddleware, sendComputeHealthResponse, sendComputeAdminError, registerComputeAdminRoutes });
