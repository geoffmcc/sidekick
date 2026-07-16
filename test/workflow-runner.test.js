const assert = require("assert");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-workflow-runner-" + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = DATA_DIR;

delete require.cache[require.resolve("../src/db")];
delete require.cache[require.resolve("../src/platform/kernel")];

const dbStore = require("../src/db");
const platformKernel = require("../src/platform/kernel");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function cleanup() {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

const STEPS = [
  { name: "fetch_data", tool_name: "sidekick_bash", args: { command: "curl -s api.example.com" } },
  { name: "process_data", tool_name: "sidekick_bash", args: { command: "jq '.results'" } },
  { name: "store_results", tool_name: "sidekick_store", args: { key: "results", value: "processed" } },
];

// WF.1: createWorkflow creates workflow with steps
test("WF.1: createWorkflow creates workflow with steps", () => {
  const wf = platformKernel.createWorkflow({ name: "deploy_pipeline", steps: STEPS, created_by: "admin" });
  assert.ok(wf.workflow_id);
  assert.strictEqual(wf.name, "deploy_pipeline");
  assert.strictEqual(wf.state, "defined");
  assert.strictEqual(wf.total_steps, 3);
  assert.strictEqual(wf.steps.length, 3);
  assert.strictEqual(wf.steps[0].name, "fetch_data");
  assert.strictEqual(wf.steps[0].state, "pending");
  assert.strictEqual(wf.steps[2].name, "store_results");
});

// WF.2: startWorkflow transitions defined -> running
test("WF.2: startWorkflow transitions to running", () => {
  const wf = platformKernel.createWorkflow({ name: "test_start", steps: [{ name: "s1" }] });
  const running = platformKernel.startWorkflow(wf.workflow_id, { actor_id: "admin" });
  assert.strictEqual(running.state, "running");
  assert.strictEqual(running.current_step, 0);
});

// WF.3: startWorkflow rejects invalid state
test("WF.3: startWorkflow rejects invalid state", () => {
  const wf = platformKernel.createWorkflow({ name: "test_reject", steps: [] });
  platformKernel.startWorkflow(wf.workflow_id);
  assert.throws(() => { platformKernel.startWorkflow(wf.workflow_id); }, /cannot be started/);
});

// WF.4: advanceWorkflow marks current step as running
test("WF.4: advanceWorkflow marks step as running", () => {
  const wf = platformKernel.createWorkflow({ name: "test_advance", steps: STEPS });
  platformKernel.startWorkflow(wf.workflow_id);
  const advanced = platformKernel.advanceWorkflow(wf.workflow_id, { actor_id: "admin" });
  assert.strictEqual(advanced.steps[0].state, "running");
  assert.ok(advanced.steps[0].started_at);
});

// WF.5: completeWorkflowStep advances to next step
test("WF.5: completeWorkflowStep advances to next", () => {
  const wf = platformKernel.createWorkflow({ name: "test_complete", steps: STEPS });
  platformKernel.startWorkflow(wf.workflow_id);
  platformKernel.advanceWorkflow(wf.workflow_id);
  const step = wf.steps[0];
  const completed = platformKernel.completeWorkflowStep(wf.workflow_id, step.step_id, { result_summary: "done" });
  assert.strictEqual(completed.steps[0].state, "completed");
  assert.strictEqual(completed.current_step, 1);
});

// WF.6: completeWorkflowStep on last step completes workflow
test("WF.6: completeWorkflowStep on last step completes workflow", () => {
  const wf = platformKernel.createWorkflow({ name: "test_final", steps: [{ name: "only" }] });
  platformKernel.startWorkflow(wf.workflow_id);
  platformKernel.advanceWorkflow(wf.workflow_id);
  const completed = platformKernel.completeWorkflowStep(wf.workflow_id, wf.steps[0].step_id, { result_summary: "done" });
  assert.strictEqual(completed.state, "completed");
  assert.ok(completed.completed_at);
});

// WF.7: completeWorkflowStep with error fails step
test("WF.7: completeWorkflowStep with error fails step", () => {
  const wf = platformKernel.createWorkflow({ name: "test_fail_step", steps: [{ name: "bad_step" }] });
  platformKernel.startWorkflow(wf.workflow_id);
  platformKernel.advanceWorkflow(wf.workflow_id);
  const failed = platformKernel.completeWorkflowStep(wf.workflow_id, wf.steps[0].step_id, { error: "boom", error_category: "tool_error" });
  assert.strictEqual(failed.steps[0].state, "failed");
  assert.strictEqual(failed.steps[0].error_category, "tool_error");
  assert.strictEqual(failed.state, "running");
});

// WF.8: completeWorkflowStep with retry resets step
test("WF.8: completeWorkflowStep with retry resets step", () => {
  const wf = platformKernel.createWorkflow({ name: "test_retry", steps: [{ name: "retry_step", max_retries: 2 }] });
  platformKernel.startWorkflow(wf.workflow_id);
  platformKernel.advanceWorkflow(wf.workflow_id);
  platformKernel.completeWorkflowStep(wf.workflow_id, wf.steps[0].step_id, { error: "temp", shouldRetry: true });
  const step = platformKernel.getWorkflow(wf.workflow_id).steps[0];
  assert.strictEqual(step.state, "pending");
  assert.strictEqual(step.retry_count, 1);
});

// WF.9: checkpointWorkflow saves checkpoint
test("WF.9: checkpointWorkflow saves checkpoint", () => {
  const wf = platformKernel.createWorkflow({ name: "test_checkpoint", steps: [] });
  platformKernel.startWorkflow(wf.workflow_id);
  const cp = platformKernel.checkpointWorkflow(wf.workflow_id, { cursor: 42, last_file: "out.json" });
  assert.strictEqual(cp.checkpoint.cursor, 42);
  assert.strictEqual(cp.checkpoint.last_file, "out.json");
});

// WF.10: pauseWorkflow pauses running workflow
test("WF.10: pauseWorkflow pauses running", () => {
  const wf = platformKernel.createWorkflow({ name: "test_pause", steps: [] });
  platformKernel.startWorkflow(wf.workflow_id);
  const paused = platformKernel.pauseWorkflow(wf.workflow_id);
  assert.strictEqual(paused.state, "paused");
});

// WF.11: failWorkflow marks workflow as failed
test("WF.11: failWorkflow marks failed", () => {
  const wf = platformKernel.createWorkflow({ name: "test_wf_fail", steps: [] });
  platformKernel.startWorkflow(wf.workflow_id);
  const failed = platformKernel.failWorkflow(wf.workflow_id, { reason: "timeout" });
  assert.strictEqual(failed.state, "failed");
  assert.ok(failed.failed_at);
});

// WF.12: advanceWorkflow rejects non-running workflow
test("WF.12: advanceWorkflow rejects non-running", () => {
  const wf = platformKernel.createWorkflow({ name: "test_advance_reject", steps: [{ name: "s1" }] });
  assert.throws(() => { platformKernel.advanceWorkflow(wf.workflow_id); }, /not running/);
});

// WF.13: advanceWorkflow completes when no more steps
test("WF.13: advanceWorkflow completes when no more steps", () => {
  const wf = platformKernel.createWorkflow({ name: "test_no_steps", steps: [] });
  platformKernel.startWorkflow(wf.workflow_id);
  const completed = platformKernel.advanceWorkflow(wf.workflow_id);
  assert.strictEqual(completed.state, "completed");
});

// WF.14: workflow emits events
test("WF.14: workflow emits events", () => {
  const wf = platformKernel.createWorkflow({ name: "test_events", steps: [{ name: "s1" }] });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'workflow.created' AND subject_id = ?").all(wf.workflow_id);
  assert.ok(events.length > 0);
});

// RN.1: createRunnerSession creates active session
test("RN.1: createRunnerSession creates active session", () => {
  const runner = platformKernel.createRunnerSession({ actor_id: "runner-1", resource_limits: { max_memory_mb: 512 } });
  assert.ok(runner.runner_id);
  assert.strictEqual(runner.state, "active");
  assert.ok(runner.started_at);
});

// RN.2: updateRunnerHeartbeat updates usage
test("RN.2: updateRunnerHeartbeat updates usage", () => {
  const runner = platformKernel.createRunnerSession({ actor_id: "runner-2" });
  const updated = platformKernel.updateRunnerHeartbeat(runner.runner_id, { memory_mb: 128, cpu_percent: 15 });
  assert.ok(updated.heartbeat_at);
  assert.strictEqual(updated.resource_usage_json.includes("128"), true);
});

// RN.3: completeRunnerSession marks completed
test("RN.3: completeRunnerSession marks completed", () => {
  const runner = platformKernel.createRunnerSession({ actor_id: "runner-3" });
  const completed = platformKernel.completeRunnerSession(runner.runner_id);
  assert.strictEqual(completed.state, "completed");
  assert.ok(completed.completed_at);
});

// RN.4: terminateRunnerSession marks terminated
test("RN.4: terminateRunnerSession marks terminated", () => {
  const runner = platformKernel.createRunnerSession({ actor_id: "runner-4" });
  const terminated = platformKernel.terminateRunnerSession(runner.runner_id, { reason: "timeout" });
  assert.strictEqual(terminated.state, "terminated");
  assert.strictEqual(terminated.terminated_reason, "timeout");
});

// RN.5: getRunnerSession returns parsed fields
test("RN.5: getRunnerSession returns parsed fields", () => {
  const runner = platformKernel.createRunnerSession({ actor_id: "runner-5", resource_limits: { max_cpu: 2 }, metadata: { region: "us-east" } });
  const got = platformKernel.getRunnerSession(runner.runner_id);
  assert.deepStrictEqual(got.resource_limits, { max_cpu: 2 });
  assert.deepStrictEqual(got.metadata, { region: "us-east" });
});

// RN.6: getRunnerSession returns null for missing
test("RN.6: getRunnerSession returns null for missing", () => {
  const got = platformKernel.getRunnerSession("run_nonexistent");
  assert.strictEqual(got, null);
});

// RN.7: runner emits events
test("RN.7: runner emits events", () => {
  const runner = platformKernel.createRunnerSession({ actor_id: "runner-7" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'runner.created' AND subject_id = ?").all(runner.runner_id);
  assert.ok(events.length > 0);
});

// RN.8: terminateRunnerSession emits warning event
test("RN.8: terminate emits warning event", () => {
  const runner = platformKernel.createRunnerSession({ actor_id: "runner-8" });
  platformKernel.terminateRunnerSession(runner.runner_id, { reason: "resource_limit" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'runner.terminated' AND subject_id = ?").all(runner.runner_id);
  assert.ok(events.length > 0);
  assert.strictEqual(events[0].severity, "warning");
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
