"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
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

async function testResponseBound() {
  const oversized = new Response("x".repeat(256 * 1024 + 1), { status: 200 });
  const executor = createLifecycleExecutor({ baseUrl: "http://127.0.0.1", fetchImpl: async () => oversized });
  await assert.rejects(() => executor.run(scenario), /response exceeds the size bound/);
}

async function testRealLoopbackAgentProcess() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-certification-agent-"));
  const childScript = [
    "const agent = require('./src/agent');",
    "agent.__setLLMOverrideForTests(async () => { await new Promise(resolve => setTimeout(resolve, 500)); return { response: JSON.stringify({ think: 'waiting for cancellation' }), provider: 'test', model: 'test-model' }; });",
    "const server = agent.app.listen(0, '127.0.0.1', () => console.log('CERT_PORT=' + server.address().port));",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", childScript], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      SIDEKICK_DATA_DIR: dataDir,
      SIDEKICK_TOOL_POLICY: "open",
      SIDEKICK_APPROVAL_MODE: "off",
      SIDEKICK_DISABLE_OLLAMA_BOOTSTRAP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { errors += chunk.toString(); });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`real Agent process did not start: ${errors.slice(0, 300)}`)), 10000);
      const onData = () => {
        const match = output.match(/CERT_PORT=(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      child.stdout.on("data", onData);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => {
        if (!output.includes("CERT_PORT=")) {
          clearTimeout(timer);
          reject(new Error(`real Agent process exited before listening (${code || signal})`));
        }
      });
    });
    const executor = createLifecycleExecutor({ baseUrl: `http://127.0.0.1:${port}`, pollMs: 10, timeoutMs: 45000 });
    assert.strictEqual(await executor.available(), true);
    const observed = await executor.run({
      objective: "check disk usage on the loopback Agent",
      required_initial_state: { project: "agent-certification", workspace: "workspace:agent-certification" },
    }, { cancelAfterPolls: 1 });
    assert.strictEqual(observed.source, "durable_task_store");
    assert.strictEqual(observed.state, "cancelled");
    assert.ok(observed.task_id);
    assert.strictEqual(observed.cancellation.requested, true);
    assert.ok(observed.events.some(event => event.event_type === "task.cancel_requested"));
    assert.ok(observed.events.some(event => event.event_type === "task.completed"));
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  await testCompletion();
  await testCancel();
  await testTimeout();
  await testValidationAndError();
  await testRealLoopbackAgentProcess();
  await testResponseBound();
  console.log("Certification lifecycle tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
