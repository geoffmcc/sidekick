"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerClearRoutes } = require("../src/dashboard/clear-routes");

function harness({ authorized = true, failRequestAudit = false, failCompletionAudit = false } = {}) {
  const handlers = new Map();
  const calls = [];
  registerClearRoutes({
    app: { delete: (route, handler) => handlers.set(route, handler) },
    dbStore: {
      clearToolLogs() { calls.push("clear_logs"); },
      clearKV() { calls.push("clear_kv"); },
    },
    clearConversationFiles() { calls.push("clear_conversations"); return 3; },
    requireDashboardAdministrator: (_req, res) => {
      calls.push("authorize");
      if (!authorized) { res.status(403).json({ code: "forbidden" }); return false; }
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

function invoke(handler) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  handler({ params: {}, body: {}, query: {} }, res);
  return res;
}

test("all destructive dashboard clears stop when request auditing is unavailable", () => {
  const { handlers, calls } = harness({ failRequestAudit: true });
  for (const route of ["/api/logs", "/api/kv", "/api/conversations", "/api/data"]) {
    const response = invoke(handlers.get(route));
    assert.equal(response.statusCode, 503, route);
    assert.equal(response.body.code, "audit_unavailable", route);
  }
  assert.equal(calls.some(call => typeof call === "string" && call.startsWith("clear_")), false);
});

test("dashboard clear returns success with degraded audit status if completion sink fails", () => {
  const { handlers, calls } = harness({ failCompletionAudit: true });
  const response = invoke(handlers.get("/api/data"));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.deepEqual(calls.filter(call => typeof call === "string" && call.startsWith("clear_")), ["clear_logs", "clear_kv", "clear_conversations"]);
});

test("dashboard clears are authorized before any audit or destructive side effect", () => {
  const { handlers, calls } = harness({ authorized: false });
  const response = invoke(handlers.get("/api/data"));
  assert.equal(response.statusCode, 403);
  assert.deepEqual(calls, ["authorize"]);
});
