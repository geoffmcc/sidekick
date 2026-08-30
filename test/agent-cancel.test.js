"use strict";

// Agent Bridge cancellation + crash-recovery tests. Boots the real
// src/agent.js express app on a test port (as agent-bridge-followup.test.js
// does) with a deterministic injected LLM — no live model or network.
//
// Covers:
//   - boot sweep: a platform execution stranded `running` by a dead process is
//     terminalised, while parked and fresh executions are left alone
//   - POST /api/agent/run/:taskId/cancel: validation, 404 for non-running
//     tasks, and a real mid-task cancel ending in transcript status
//     `cancelled` and kernel state `cancelled` (a legal running→cancelled
//     transition, not a fake failure)
//   - /api/agent/stream/:taskId for an unknown task emits type "error", not a
//     fake "done"

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-agent-cancel-"));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_ENVIRONMENT = "test";

process.on("exit", () => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});

const PORT = 4143;

delete require.cache[require.resolve("../src/agent")];
const agent = require("../src/agent");
const platformKernel = require("../src/platform/kernel");
const { createTask } = require("../src/agent/task-model");
const durableTasks = require("../src/agent/task-store");

console.log("Running Agent Bridge cancellation/sweep tests...\n");

{
  const watch = { id: "retained-watch", interval: "1h", status: "active" };
  agent.scheduleWatch(watch);
  const first = agent.watchIntervals[watch.id];
  agent.scheduleWatch(watch);
  const second = agent.watchIntervals[watch.id];
  assert.notStrictEqual(first, second, "duplicate watch scheduling should replace its interval");
  assert.strictEqual(first._destroyed, true, "replaced watch interval should be cleared");
  clearInterval(second);
  delete agent.watchIntervals[watch.id];
  console.log("  ok - duplicate watch scheduling clears the replaced interval");
}

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    console.error("  FAIL - " + name);
    console.error("    " + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: "127.0.0.1", port: PORT, path: urlPath, method,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        let parsed = out;
        try { parsed = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Collect the full SSE body for a task stream (the server ends the response
// itself for unknown tasks and terminal events).
function readStream(taskId, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: PORT, path: "/api/agent/stream/" + taskId }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve(out));
    });
    req.on("error", reject);
    setTimeout(() => { try { req.destroy(); } catch {} resolve(null); }, timeoutMs);
  });
}

function transcriptPath(id) {
  return path.join(agent.CONV_DIR, id + ".json");
}
async function waitForTranscript(id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(transcriptPath(id))) {
      try {
        const transcript = JSON.parse(fs.readFileSync(transcriptPath(id), "utf-8"));
        if (["completed", "failed", "iteration_limit", "timed_out", "cancelled"].includes(transcript.status)) return transcript;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for transcript " + id);
}

// Deterministic LLM: the tool-loop path blocks on a gate the test releases,
// which pins the task inside iteration 1 while cancel is requested.
let gate = null;
let fake = () => ({ response: JSON.stringify({ think: "waiting" }), provider: "test", model: "test-model" });
agent.__setLLMOverrideForTests((messages, options) => {
  const isToolLoop = options && options.format === "json";
  if (!isToolLoop) return Promise.resolve({ response: "direct", provider: "test", model: "test-model" });
  return new Promise((resolve) => {
    gate = () => resolve(fake());
  });
});

function makeExecution(taskId) {
  const created = platformKernel.createExecution({
    task_id: taskId,
    actor_id: "agent",
    client_id: "agent-bridge",
    trigger_type: "agent",
    operation_type: "agent_task",
    tool_name: "sidekick_agent",
    tool_action: "run",
    risk: "medium",
    source: "agent",
    correlation_id: taskId,
  });
  return platformKernel.transitionExecution(created.execution_id, "running", { source: "agent", reason: "test task started" });
}

let server;
(async () => {
  server = agent.app.listen(PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  // ---- boot sweep -----------------------------------------------------------
  await ok("sweep terminalises a crash-stranded running agent_task execution", async () => {
    const stranded = makeExecution("aaaa1111");
    const parked = makeExecution("aaaa2222");
    platformKernel.transitionExecution(parked.execution_id, "awaiting_approval", { source: "agent", reason: "test park" });

    // Boot instant AFTER both rows were written: both look pre-boot, but only
    // the `running` one is stranded.
    const bootIso = new Date(Date.now() + 60000).toISOString();
    const swept = agent.sweepStrandedAgentExecutions(bootIso);
    assert.ok(swept.includes(stranded.execution_id), "stranded running row should be swept");
    assert.strictEqual(platformKernel.getExecution(stranded.execution_id).state, "failed");
    assert.strictEqual(platformKernel.getExecution(parked.execution_id).state, "awaiting_approval",
      "parked execution must not be touched by the sweep");
  });

  await ok("sweep leaves executions newer than boot alone", async () => {
    const fresh = makeExecution("aaaa3333");
    const pastBootIso = new Date(Date.now() - 60000).toISOString();
    const swept = agent.sweepStrandedAgentExecutions(pastBootIso);
    assert.ok(!swept.includes(fresh.execution_id), "post-boot running row must not be swept");
    assert.strictEqual(platformKernel.getExecution(fresh.execution_id).state, "running");
    // Tidy so later sweeps in this process cannot pick it up.
    platformKernel.transitionExecution(fresh.execution_id, "completed", { source: "agent", reason: "test cleanup" });
  });

  // ---- cancel route validation ---------------------------------------------
  await ok("cancel rejects an invalid task id (400)", async () => {
    const res = await request("POST", "/api/agent/run/not-a-task/cancel", {});
    assert.strictEqual(res.status, 400);
  });

  await ok("cancel of a non-running task is 404, never fake success", async () => {
    const res = await request("POST", "/api/agent/run/deadbeef/cancel", {});
    assert.strictEqual(res.status, 404);
    assert.match(JSON.stringify(res.data), /not running/i);
  });

  // ---- live cancel ----------------------------------------------------------
  await ok("cancel mid-task ends with transcript status `cancelled` and kernel state `cancelled`", async () => {
    gate = null;
    // Goal phrased to route through the tool loop (system_inspection).
    const run = await request("POST", "/api/agent/run", { goal: "check disk usage on this machine" });
    assert.strictEqual(run.status, 200);
    const taskId = run.data.taskId;

    // Wait until the loop is inside its first LLM call (gate armed).
    const start = Date.now();
    while (!gate && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(gate, "tool loop should be waiting on the LLM");

    const child = createTask({ task_id: "childcancel1", root_task_id: taskId, parent_task_id: taskId, objective: "child cancellation", profile: "quick" });
    durableTasks.insertTask(child);
    for (const state of ["planning", "ready", "running"]) durableTasks.updateTask(child.task_id, { state, phase: "execution" }, "test.child_running");

    const cancel = await request("POST", "/api/agent/run/" + taskId + "/cancel", {});
    assert.strictEqual(cancel.status, 200);
    assert.strictEqual(cancel.data.ok, true);
    assert.strictEqual(cancel.data.cancelling, true);
    assert.ok(cancel.data.affected_task_ids.includes(taskId));
    assert.ok(cancel.data.affected_task_ids.includes(child.task_id));
    assert.strictEqual(durableTasks.getTask(child.task_id).control.cancel_requested, true, "durable child cancellation is propagated");

    // Release the in-flight LLM call; the loop consumes the cancel flag at the
    // top of the next iteration.
    gate();
    const transcript = await waitForTranscript(taskId);
    assert.strictEqual(transcript.status, "cancelled");
    assert.match(String(transcript.error || ""), /cancelled/i);

    // Kernel agrees: the execution ended in the first-class `cancelled` state
    // via a legal running→cancelled transition — not `failed`, not stranded.
    const executionId = transcript.lineage && transcript.lineage.platform_execution_id;
    assert.ok(executionId, "transcript should carry the platform execution id");
    assert.strictEqual(platformKernel.getExecution(executionId).state, "cancelled");

    // A second cancel after terminal is honestly a 404 (controller removed).
    const again = await request("POST", "/api/agent/run/" + taskId + "/cancel", {});
    assert.strictEqual(again.status, 404);
  });

  // ---- stream honesty --------------------------------------------------------
  await ok("stream for an unknown task emits type error, not a fake done", async () => {
    const body = await readStream("0badf00d");
    assert.ok(body !== null, "stream should end on its own");
    assert.match(body, /"type":"error"/);
    assert.match(body, /Task not found/);
    assert.doesNotMatch(body, /"type":"done"/);
  });

  console.log("\nAll " + passed + " cancellation/sweep tests passed.\n");
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try { server && server.close(); } catch {}
  process.exit(1);
});
