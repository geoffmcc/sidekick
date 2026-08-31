"use strict";

const assert = require("assert");
const { createLiveAgentExecutor } = require("../src/certification/live-agent");

const calls = [];
let polls = 0;
const fetchImpl = async (url, options) => {
  calls.push({ url: String(url), method: options.method || "GET", body: options.body || null });
  if (String(url).endsWith("/api/health")) return new Response(JSON.stringify({ ok: true, status: "healthy", invariants: { severity: "ok" } }), { status: 200 });
  if (String(url).endsWith("/api/agent/run")) return new Response(JSON.stringify({ taskId: "task_certification_1" }), { status: 200 });
  polls++;
  return new Response(JSON.stringify({
    source: "durable_task_store",
    task: polls === 1 ? { task_id: "task_certification_1", state: "running" } : { task_id: "task_certification_1", state: "completed", result: { status: "verified", summary: "bounded result" } },
    receipts: [],
    events: [{ event_type: "task.completed", task_id: "task_certification_1" }],
  }), { status: 200 });
};

(async () => {
  const executor = createLiveAgentExecutor({ baseUrl: "http://127.0.0.1:4199", fetchImpl, pollMs: 1 });
  assert.strictEqual(await executor.available(), true);
  const observed = await executor.run({
    objective: "inspect the isolated certification repository",
    required_initial_state: { project: "agent-certification", workspace: "workspace:agent-certification" },
  });
  assert.strictEqual(observed.state, "completed");
  assert.strictEqual(observed.result.status, "verified");
  assert.strictEqual(calls.filter(call => call.url.endsWith("/api/agent/run")).length, 1);
  assert.strictEqual(calls.filter(call => call.url.includes("/control-room")).length, 2);
  assert.match(calls.find(call => call.url.endsWith("/api/agent/run")).body, /agent-certification/);

  const { runCertification } = require("../src/certification");
  const missingEvidence = await runCertification({
    mode: "live",
    availability: true,
    liveExecutor: { run: async () => ({ state: "completed", source: "durable_task_store", receipts: [], events: [], dispatch_counts: { total: 1 }, result: { status: "verified" } }) },
  });
  assert.strictEqual(missingEvidence.summary.failed, 2, "live certification must reject fabricated completion evidence");
  assert.ok(missingEvidence.results.every(result => /expected tools were not observed/.test(result.reason)));
  console.log("Passed: live Agent certification executor");
})().catch(error => { console.error(error); process.exitCode = 1; });
