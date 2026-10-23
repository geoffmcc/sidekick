"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerScopeSnapshotRoutes } = require("../src/dashboard/scope-snapshot-routes");

function harness({ allowed = true, failRequestAudit = false, failCompletionAudit = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = { get: (route, handler) => handlers.set(`GET ${route}`, handler), post: (route, handler) => handlers.set(`POST ${route}`, handler) };
  const platformKernel = {
    getProject: projectId => ({ project_id: projectId, state: "active" }),
    createScopeSnapshot: input => { calls.push(["create", input]); return { snapshot_id: "snapshot-1", digest: "digest-1", target_count: input.targets.length }; },
  };
  registerScopeSnapshotRoutes({
    app,
    platformKernel,
    projectAccess: { hasProjectAccess: () => true },
    authenticatedUser: () => "principal-1",
    requireIdentityPermission: (_req, res) => {
      calls.push("permission");
      if (!allowed) { res.status(403).json({ code: "forbidden" }); return false; }
      return true;
    },
    auditLog: (_req, action) => {
      calls.push(["audit", action]);
      if (failRequestAudit && action.endsWith(".requested")) throw new Error("request audit unavailable");
      if (failCompletionAudit && !action.endsWith(".requested")) throw new Error("completion audit unavailable");
    },
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });
  return { handlers, calls };
}

function invoke(handler, request = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  handler({ params: {}, body: {}, query: {}, authPrincipal: { principal_id: "principal-1", scopes: [] }, ...request }, res);
  return res;
}

test("scope snapshot request-audit failure prevents durable snapshot creation", () => {
  const { handlers, calls } = harness({ failRequestAudit: true });
  const response = invoke(handlers.get("POST /api/scope-snapshots"), { body: { project_id: "project-1", targets: [{ kind: "host", value: "host-1" }] } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === "create"), false);
});

test("scope snapshot creation preserves actor attribution and reports completion-audit degradation", () => {
  const { handlers, calls } = harness({ failCompletionAudit: true });
  const response = invoke(handlers.get("POST /api/scope-snapshots"), { body: { project_id: "project-1", targets: [{ kind: "host", value: "host-1" }] } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  const create = calls.find(call => Array.isArray(call) && call[0] === "create");
  assert.equal(create[1].created_by, "principal-1");
  assert.equal(create[1].project_id, "project-1");
});

test("scope snapshot creation is denied before audit and persistence without project write access", () => {
  const handlers = new Map();
  const calls = [];
  const app = { get: (route, handler) => handlers.set(`GET ${route}`, handler), post: (route, handler) => handlers.set(`POST ${route}`, handler) };
  registerScopeSnapshotRoutes({
    app,
    platformKernel: { getProject: projectId => ({ project_id: projectId, state: "active" }), createScopeSnapshot: () => calls.push("create") },
    projectAccess: { hasProjectAccess: () => false },
    authenticatedUser: () => "principal-1",
    requireIdentityPermission: () => true,
    auditLog: () => calls.push("audit"),
    errorResponse() {},
  });
  const response = invoke(handlers.get("POST /api/scope-snapshots"), { body: { project_id: "project-1" } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(calls, []);
});
