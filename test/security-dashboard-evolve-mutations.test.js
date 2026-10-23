"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerEvolveRoutes } = require("../src/dashboard/evolve-routes");

function harness({ allowed = true, failRequestAudit = false, failCompletionAudit = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = { get: (route, handler) => handlers.set(`GET ${route}`, handler), post: (route, handler) => handlers.set(`POST ${route}`, handler) };
  const dbStore = {
    getGeneratedCapability() { calls.push("capability_read"); return { id: "cap-1", name: "generated-test", state: "active" }; },
    getGeneratedCapabilityByName() { calls.push("capability_name_read"); return null; },
    createGeneratedToolExecution() { calls.push("execution_create"); },
    getGeneratedToolExecution(id) { calls.push("execution_read"); return { id, state: "queued" }; },
  };
  const dynamicTools = {
    cancelExecution(id) { calls.push(["cancel", id]); return { id, state: "cancelled" }; },
    onExecutionEvent() { return () => {}; },
  };
  registerEvolveRoutes({
    app,
    evolveDashboardAction() {},
    authenticatedUser: () => "principal-1",
    dbStore,
    shapeExecution: value => value,
    requireAttributedActor: () => "principal-1",
    requireIdentityPermission: (_req, res) => {
      calls.push("permission");
      if (!allowed) { res.status(403).json({ code: "forbidden" }); return false; }
      return true;
    },
    hasIdentityPermission: () => allowed,
    crypto: { randomBytes: () => Buffer.from("abcdef123456", "hex") },
    callDashboardTool: async () => { calls.push("dispatch"); return {}; },
    dashboardExecutionMetadata: () => ({}),
    redactSensitive: String,
    auditLog: (_req, action) => {
      calls.push(["audit", action]);
      if (failRequestAudit && action.endsWith(".requested")) throw new Error("request audit unavailable");
      if (failCompletionAudit && !action.endsWith(".requested")) throw new Error("completion audit unavailable");
    },
    dynamicTools,
    logError() {},
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });
  return { handlers, calls };
}

function invoke(handler, request = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  handler({ params: {}, body: {}, query: {}, ...request }, res);
  return res;
}

test("generated execution run and cancel require operations management permission", () => {
  const { handlers, calls } = harness({ allowed: false });
  const run = invoke(handlers.get("POST /api/evolve/:id/run"), { params: { id: "cap-1" } });
  const cancel = invoke(handlers.get("POST /api/evolve/executions/:executionId/cancel"), { params: { executionId: "execution-1" } });
  assert.equal(run.statusCode, 403);
  assert.equal(cancel.statusCode, 403);
  assert.deepEqual(calls, ["permission", "permission"]);
});

test("generated execution request-audit failures prevent dispatch and cancellation", () => {
  const { handlers, calls } = harness({ failRequestAudit: true });
  const run = invoke(handlers.get("POST /api/evolve/:id/run"), { params: { id: "cap-1" } });
  const cancel = invoke(handlers.get("POST /api/evolve/executions/:executionId/cancel"), { params: { executionId: "execution-1" } });
  assert.equal(run.statusCode, 503);
  assert.equal(cancel.statusCode, 503);
  assert.equal(calls.some(call => call === "execution_create" || call === "dispatch" || (Array.isArray(call) && call[0] === "cancel")), false);
});

test("generated execution cancellation remains successful when completion audit is degraded", () => {
  const { handlers, calls } = harness({ failCompletionAudit: true });
  const response = invoke(handlers.get("POST /api/evolve/executions/:executionId/cancel"), { params: { executionId: "execution-1" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === "cancel"), ["cancel", "execution-1"]);
});
