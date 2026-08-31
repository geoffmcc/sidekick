"use strict";

const assert = require("assert");
const { createLifecycleExecutor } = require("../src/certification/lifecycle");

const scenario = { objective: "certify the bounded Agent lifecycle", required_initial_state: { project: "certification", workspace: "workspace:certification" } };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

async function testCompletion() {
  const calls = [];
  let poll = 0;
  const executor = createLifecycleExecutor({ baseUrl: "http://127.0.0.1:4199", pollMs: 0, fetchImpl: async (url, options) => {
    calls.push({ path: new URL(url).pathname, options });
    if (calls.length === 1) return response({ taskId: "task-complete" });
    poll++;
    return response({ source: "durable_task_store", task: { state: poll === 1 ? "running" : "completed", result: { status: "verified" } }, receipts: [{ dispatch_state: "finalized" }], events: [{ event_type: "task.completed" }], dispatch_counts: { total: 1, completed: 1 } });
  } });
  const result = await executor.run(scenario);
  assert.strictEqual(result.state, "completed");
  assert.deepStrictEqual(result.dispatch_counts, { total: 1, completed: 1 });
  assert.strictEqual(calls.filter(call => call.path.includes("control-room")).length, 2);
  assert.strictEqual(calls.filter(call => call.path.endsWith("/run")).length, 1);
}

async function testCancel() {
  const paths = [];
  const executor = createLifecycleExecutor({ baseUrl: "http://localhost:4199", pollMs: 0, fetchImpl: async url => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith("/run")) return response({ task_id: "task-cancel" });
    if (path.endsWith("/cancel")) return response({ ok: true });
    return response({ task: { state: paths.filter(item => item.includes("control-room")).length === 1 ? "running" : "cancelled" }, receipts: [], events: [] });
  } });
  const result = await executor.run(scenario, { cancelAfterPolls: 1 });
  assert.strictEqual(result.state, "cancelled");
  assert.ok(paths.some(path => path.endsWith("/cancel")));
  assert.strictEqual(paths.filter(path => path.endsWith("/cancel")).length, 1);
}

async function testTimeout() {
  const executor = createLifecycleExecutor({ baseUrl: "https://[::1]:4199", timeoutMs: 1000, pollMs: 0, fetchImpl: async url => new URL(url).pathname.endsWith("/run") ? response({ taskId: "task-timeout" }) : response({ task: { state: "running" }, receipts: [], events: [] }) });
  const result = await executor.run(scenario);
  assert.strictEqual(result.timeout, true);
  assert.strictEqual(result.state, "running");
}

async function testValidationAndError() {
  assert.throws(() => createLifecycleExecutor({ baseUrl: "https://example.test" }), /loopback/);
  assert.throws(() => createLifecycleExecutor({ baseUrl: "http://127.0.0.1", headers: { "x-fault-injection": "true" } }), /fault injection/);
  const executor = createLifecycleExecutor({ baseUrl: "http://127.0.0.1", fetchImpl: async () => response({ error: "provider token ghp_secret" }, 503) });
  await assert.rejects(() => executor.run(scenario), /HTTP 503/);
  await assert.rejects(() => executor.run({ ...scenario, fault_point: "dispatch" }), /fault injection/);
}

(async () => {
  await testCompletion();
  await testCancel();
  await testTimeout();
  await testValidationAndError();
  console.log("Certification lifecycle tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
