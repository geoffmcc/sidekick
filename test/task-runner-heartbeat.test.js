"use strict";

// Task-runner liveness heartbeat tests (T2 honesty).
//
// executeApprovedTool's T2 path used to answer "the task is runnable and will
// be resumed by the task runner" unconditionally — even with Brain disabled or
// the agent service down, when nothing would ever resume the task. The resume
// scheduler now writes a heartbeat into the approvals store every poll, and T2
// reports honestly when that heartbeat is absent or stale. Real SQLite, no
// network, deterministic.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-runner-heartbeat-"));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_SECRET_KEY = "task-runner-heartbeat-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

process.on("exit", () => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});

const store = require("../src/approvals/store");
const continuation = require("../src/approvals/continuation");
const scheduler = require("../src/brain/scheduler");
const dispatcher = require("../src/tools/dispatcher");

console.log("Running task-runner heartbeat tests...\n");

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

function samplePlan(stepId, tool, args) {
  return {
    version: 1,
    goal: "do the thing",
    steps: [
      { id: "s1", type: "tool", tool: "health", arguments: { check: "all" } },
      { id: stepId, type: "tool", tool, arguments: args },
      { id: "s3", type: "synthesis", depends_on: ["s1", stepId] },
    ],
  };
}

let taskCounter = 0;
function parkTask() {
  taskCounter++;
  const taskId = `hbtask${taskCounter.toString(16).padStart(2, "0")}`;
  const stepId = "s2";
  const args = { command: "echo heartbeat " + taskCounter };
  const plan = samplePlan(stepId, "bash", args);
  const parked = continuation.park({
    taskId,
    goal: plan.goal,
    classification: { requiresTools: true },
    plan,
    stepId,
    toolName: "bash",
    args,
    risk: "high",
    source: "agent",
    requesterIdentity: "agent",
    evidence: [{ id: "s1", tool: "health", text: "ok" }],
    evidenceChars: 2,
    successfulToolEvidence: 1,
    deadlineAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.strictEqual(parked.ok, true, "park should succeed: " + JSON.stringify(parked));
  return { taskId, approvalId: parked.approvalId };
}

function clearHeartbeat() {
  store.getDb().prepare("DELETE FROM approval_runtime_meta WHERE key = 'task_runner_heartbeat'").run();
}

function ageHeartbeat(ms) {
  store.getDb().prepare("UPDATE approval_runtime_meta SET updated_at = ? WHERE key = 'task_runner_heartbeat'")
    .run(new Date(Date.now() - ms).toISOString());
}

(async () => {
  store.ensureApprovalContinuationSchema();

  await ok("liveness fails closed with no heartbeat", async () => {
    clearHeartbeat();
    const liveness = store.isTaskRunnerLive();
    assert.strictEqual(liveness.live, false);
    assert.strictEqual(liveness.reason, "no_heartbeat");
  });

  await ok("a fresh heartbeat reports live; a stale one does not", async () => {
    store.writeTaskRunnerHeartbeat({ runner: "runner_test", intervalMs: 5000 });
    const fresh = store.isTaskRunnerLive();
    assert.strictEqual(fresh.live, true);
    assert.strictEqual(fresh.runner, "runner_test");

    // Window is max(3×interval, 30s) = 30s for a 5s poll; 31s old is stale.
    ageHeartbeat(31000);
    const stale = store.isTaskRunnerLive();
    assert.strictEqual(stale.live, false);
    assert.strictEqual(stale.reason, "stale_heartbeat");
  });

  await ok("the resume scheduler writes a heartbeat carrying its poll interval", async () => {
    clearHeartbeat();
    const started = scheduler.startResumeScheduler({ buildDeps: async () => null, intervalMs: 60000 });
    assert.strictEqual(started.started, true);
    try {
      // beat() runs synchronously at start, before the first poll.
      const heartbeat = store.getTaskRunnerHeartbeat();
      assert.ok(heartbeat, "heartbeat should exist immediately after start");
      assert.strictEqual(heartbeat.intervalMs, 60000);
      assert.ok(store.isTaskRunnerLive().live);
    } finally {
      scheduler.stopResumeScheduler();
    }
  });

  await ok("T2 warns when no task runner heartbeat exists (stale-runner honesty)", async () => {
    clearHeartbeat();
    const { taskId, approvalId } = parkTask();
    const result = await dispatcher.executeApprovedTool({ approvalId, reviewer: "tester" });
    assert.strictEqual(result.isError, undefined, "T2 approval itself should succeed: " + JSON.stringify(result));
    assert.strictEqual(result.status, "task_runnable", "task must still become runnable — resumption is not fabricated OR blocked");
    assert.ok(result.warning, "result should carry an explicit warning field");
    assert.match(result.warning, /no active task runner/i);
    const text = result.content[0].text;
    assert.match(text, /no active task runner/i);
    assert.doesNotMatch(text, /will be resumed by the task runner/i);
    // The checkpoint really is runnable — the warning is about liveness, not state.
    assert.strictEqual(store.getCheckpoint(taskId).state, "runnable");
  });

  await ok("T2 promises resumption only when a fresh heartbeat proves a runner", async () => {
    store.writeTaskRunnerHeartbeat({ runner: "runner_live", intervalMs: 5000 });
    const { approvalId } = parkTask();
    const result = await dispatcher.executeApprovedTool({ approvalId, reviewer: "tester" });
    assert.strictEqual(result.status, "task_runnable");
    assert.strictEqual(result.warning, undefined, "no warning when the runner is live");
    assert.match(result.content[0].text, /will be resumed by the task runner/i);
  });

  console.log("\nAll " + passed + " task-runner heartbeat tests passed.\n");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
