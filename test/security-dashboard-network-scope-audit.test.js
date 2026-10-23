"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerNetworkScopeRoutes } = require("../src/dashboard/network-scope-routes");

function harness({ allowed = true, failRequestAudit = false, failCompletionAudit = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = {
    get: (route, handler) => handlers.set(`GET ${route}`, handler),
    post: (route, handler) => handlers.set(`POST ${route}`, handler),
    put: (route, handler) => handlers.set(`PUT ${route}`, handler),
  };
  const scopeRegistry = {
    create(input, actor) { calls.push(["create", input, actor]); return { scope_id: "scope-1", revision: 1, digest: "digest-1" }; },
    update(id, input, actor) { calls.push(["update", id, input, actor]); return { scope_id: id, revision: 2, digest: "digest-2" }; },
    setState(id, state, actor) { calls.push(["state", id, state, actor]); return { scope_id: id, revision: 1, digest: "digest-1" }; },
    validate() { calls.push("validate"); return {}; },
    get() { calls.push("get"); return { scope_id: "scope-1", revision: 1 }; },
  };
  registerNetworkScopeRoutes({
    app,
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
    logError() {},
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
    scopeRegistry,
  });
  return { handlers, calls };
}

function invoke(handler, request = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  handler({ params: {}, body: {}, query: {}, ...request }, res);
  return res;
}

test("network-scope create, update, and state changes require a successful request audit", () => {
  const { handlers, calls } = harness({ failRequestAudit: true });
  const responses = [
    invoke(handlers.get("POST /api/network-scopes"), { body: { name: "test" } }),
    invoke(handlers.get("PUT /api/network-scopes/:scopeId"), { params: { scopeId: "scope-1" }, body: {} }),
    invoke(handlers.get("POST /api/network-scopes/:scopeId/state"), { params: { scopeId: "scope-1" }, body: { state: "disabled" } }),
  ];
  for (const response of responses) {
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, "audit_unavailable");
  }
  assert.equal(calls.some(call => Array.isArray(call) && ["create", "update", "state"].includes(call[0])), false);
});

test("network-scope create attributes the actor and exposes completion-audit degradation", () => {
  const { handlers, calls } = harness({ failCompletionAudit: true });
  const response = invoke(handlers.get("POST /api/network-scopes"), { body: { name: "test" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === "create"), ["create", { name: "test" }, "principal-1"]);
});

test("network-scope mutations stop before audit or registry access when unauthorized", () => {
  const { handlers, calls } = harness({ allowed: false });
  const response = invoke(handlers.get("POST /api/network-scopes"), { body: { name: "test" } });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(calls, ["permission"]);
});
