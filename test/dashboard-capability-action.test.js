"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { capabilityResult, createCapabilityAction } = require("../src/dashboard/capability-action");

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.value = value; return value; } };
}

test("capability result preserves structured success and bounded errors", () => {
  const ok = response();
  capabilityResult(ok, { content: [{ text: '{"level":"foundation"}' }] });
  assert.deepEqual(ok.value, { ok: true, level: "foundation" });
  const failed = response();
  capabilityResult(failed, { isError: true, content: [{ text: '{"code":"blocked"}' }] });
  assert.equal(failed.statusCode, 400);
  assert.deepEqual(failed.value, { ok: false, code: "blocked" });
});

test("capability action dispatches reads and requires an attributed actor for mutations", async () => {
  const calls = [];
  const audits = [];
  let attributed = 0;
  const action = createCapabilityAction({
    authenticatedUser: () => "reader",
    requireAttributedActor: () => { attributed++; return "principal-1"; },
    auditLog: (...args) => audits.push(args),
    callDashboardTool: async (...args) => { calls.push(args); return { content: [{ text: '{"ok":true}' }] }; },
    dashboardExecutionMetadata: (_req, actor) => ({ actor }),
    logError: () => assert.fail("unexpected capability action error"),
  });
  const readResponse = response();
  await action({ originalUrl: "/maturity", headers: {}, params: {}, body: {} }, readResponse, { action: "maturity", name: "api-engineering" }, "maturity");
  assert.equal(attributed, 0);
  assert.deepEqual(calls[0], ["capability", { action: "maturity", name: "api-engineering" }, { actor: "reader" }]);
  const mutationResponse = response();
  await action({ originalUrl: "/install", headers: {}, params: {}, body: {} }, mutationResponse, { action: "install", name: "api-engineering" }, "install");
  assert.equal(attributed, 1);
  assert.equal(audits.length, 2);
  assert.equal(calls[1][2].actor, "principal-1");
});
