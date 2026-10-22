"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerWebhookRoute } = require("../src/dashboard/webhook-route");

function harness({ failRequestAudit = false, failCompletionAudit = false } = {}) {
  const handlers = new Map();
  let stored = [];
  const calls = [];
  registerWebhookRoute({
    app: { post: (route, handler) => handlers.set(route, handler) },
    dbStore: {
      loadDocument: () => structuredClone(stored),
      setDocument: (_name, value) => { calls.push("persist"); stored = value; },
    },
    requireIdentityPermission: () => true,
    auditLog: (_req, action) => {
      calls.push(["audit", action]);
      if (failRequestAudit && action.endsWith(".requested")) throw new Error("request audit unavailable");
      if (failCompletionAudit && !action.endsWith(".requested")) throw new Error("completion audit unavailable");
    },
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });
  return { handlers, calls, getStored: () => stored };
}

function invoke(handler) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  handler({ params: { source: "synthetic" }, body: { payload: "not copied to audit" } }, res);
  return res;
}

test("webhook request-audit failure prevents persistence", () => {
  const { handlers, calls, getStored } = harness({ failRequestAudit: true });
  const response = invoke(handlers.get("/api/webhook/:source"));
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(calls.some(call => call === "persist"), false);
  assert.deepEqual(getStored(), []);
});

test("webhook completion-audit failure is reported after accepting the payload", () => {
  const { handlers, calls, getStored } = harness({ failCompletionAudit: true });
  const response = invoke(handlers.get("/api/webhook/:source"));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.equal(calls.includes("persist"), true);
  assert.equal(getStored().length, 1);
  assert.equal(JSON.stringify(calls).includes("not copied to audit"), false);
});
