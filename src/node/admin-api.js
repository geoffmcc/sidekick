"use strict";

function bearerToken(req) {
  const value = req.headers?.authorization;
  const match = typeof value === "string" ? value.match(/^Bearer\s+(.+)$/i) : null;
  return match ? match[1] : null;
}

function createPermissionMiddleware({ authentication, authorization, resourceType = "execution_node_admin", denialMessage = "execution node administration denied" }, permission) {
  return (req, res, next) => {
    const credential = authentication.authenticateCredential(bearerToken(req));
    if (!credential) return res.status(401).json({ ok: false, error: "scoped identity credential required", code: "unauthenticated" });
    const identity = {
      principal_id: credential.principal_id,
      principal_type: credential.principal_type,
      credential_id: credential.credential_id,
      scopes: credential.scopes,
      delegation_id: credential.delegation_id || null,
      authentication_method: "scoped_credential",
    };
    const decision = authorization.authorize({
      principalId: identity.principal_id,
      permission,
      credentialScopes: identity.scopes,
      delegationId: identity.delegation_id,
      resource: { tool: resourceType, source: "http", route: req.path },
    });
    if (!decision.ok) {
      req.authIdentity = identity;
      return res.status(403).json({ ok: false, error: denialMessage, code: "authorization_denied", authorization: decision });
    }
    req.authIdentity = identity;
    req.executionNodePermission = permission;
    next();
  };
}

function adminOperationFailed(res, operation) {
  return res.status(500).json({
    ok: false,
    error: `Execution-node ${operation} failed`,
    code: "execution_node_admin_failed",
  });
}

function registerExecutionNodeAdminRoutes({ app, express, authentication, authorization, identity, dbStore, executionNode, compute }) {
  const router = express.Router();
  const requirePermission = permission => createPermissionMiddleware({ authentication, authorization }, permission);

  router.get("/nodes", requirePermission("compute.nodes.read"), (req, res) => {
    res.json({ ok: true, nodes: executionNode.list() });
  });

  router.post("/nodes/:workerId/workspaces", requirePermission("compute.nodes.manage"), express.json({ limit: "16kb" }), (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.rootIdentity) return res.status(400).json({ ok: false, error: "name and rootIdentity are required" });
    const workspaceId = require("./workspace").stableId("ws", `${body.name}:${body.rootIdentity}`);
    try {
      const workspace = dbStore.getDb().transaction(() => {
        const value = executionNode.authorizeWorkspace(req.params.workerId, {
          workspaceId,
          name: String(body.name).slice(0, 64),
          rootIdentity: String(body.rootIdentity).slice(0, 128),
          permissions: body.permissions || { read: true, write: false, execute: false },
          limits: body.limits || {},
        });
        identity.recordAuditEvent("execution_node.workspace.authorized", req.authIdentity.principal_id, req.authIdentity.principal_id, {
          worker_id: req.params.workerId,
          workspace_id: value.workspaceId,
          name: value.name,
          permissions: value.permissions,
        });
        return value;
      }).immediate();
      res.json({ ok: true, workspace });
    } catch { return adminOperationFailed(res, "workspace authorization"); }
  });

  router.post("/nodes/:workerId/revoke", requirePermission("compute.nodes.manage"), express.json({ limit: "8kb" }), (req, res) => {
    try {
      const worker = dbStore.getDb().transaction(() => {
        const value = compute.workerManager.revokeWorker(req.params.workerId, req.body?.reason || "execution_node_revoked");
        if (!value) return null;
        identity.recordAuditEvent("execution_node.revoked", req.authIdentity.principal_id, req.authIdentity.principal_id, {
          worker_id: req.params.workerId,
          reason: String(req.body?.reason || "execution_node_revoked").slice(0, 200),
        });
        return value;
      }).immediate();
      if (!worker) return res.status(404).json({ ok: false, error: "node not found" });
      res.json({ ok: true, worker });
    } catch { return adminOperationFailed(res, "node revocation"); }
  });

  router.post("/jobs/:jobId/cancel", requirePermission("compute.jobs.cancel"), express.json({ limit: "8kb" }), (req, res) => {
    try {
      const job = dbStore.getDb().transaction(() => {
        const value = executionNode.requestCancel(req.params.jobId);
        if (!value) return null;
        identity.recordAuditEvent("execution_node.job.cancel_requested", req.authIdentity.principal_id, req.authIdentity.principal_id, {
          job_id: req.params.jobId,
          worker_id: value.workerId,
          state: value.state,
        });
        return value;
      }).immediate();
      if (!job) return res.status(404).json({ ok: false, error: "job not found" });
      res.json({ ok: true, job });
    } catch { return adminOperationFailed(res, "job cancellation"); }
  });

  app.use("/execution-node/admin", router);
}

module.exports = Object.freeze({ createPermissionMiddleware, registerExecutionNodeAdminRoutes });
