const assert = require("assert");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-execution-control-" + Date.now());
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

function createAndTransition(opType, targetState, opts = {}) {
  const exec = platformKernel.createExecution({
    operation_type: opType,
    tool_name: opts.tool_name || null,
    state: "created",
    source: "test",
    ...opts,
  });
  if (targetState === "completed" || targetState === "failed") {
    platformKernel.transitionExecution(exec.execution_id, "running", { source: "test" });
    platformKernel.transitionExecution(exec.execution_id, targetState, { source: "test" });
  } else if (targetState && targetState !== "created") {
    platformKernel.transitionExecution(exec.execution_id, targetState, { source: "test" });
  }
  return exec;
}

// EC.1: platformGuard finds active execution by operation_type
test("EC.1: platformGuard detects concurrent executions", () => {
  const exec = createAndTransition("cron_job", "queued", { tool_name: "cron" });
  const guard = platformKernel.platformGuard(null, null, {
    operation_type: "cron_job",
    allowConcurrent: false,
  });
  assert.strictEqual(guard.allowed, false);
  assert.strictEqual(guard.reason, "concurrent_execution");
  assert.strictEqual(guard.execution.operation_type, "cron_job");
  platformKernel.transitionExecution(exec.execution_id, "cancelled", { source: "test" });
});

// EC.2: platformGuard allows when no active execution exists
test("EC.2: platformGuard allows when no active exists", () => {
  const guard = platformKernel.platformGuard(null, null, {
    operation_type: "nonexistent_operation",
    allowConcurrent: false,
  });
  assert.strictEqual(guard.allowed, true);
  assert.strictEqual(guard.execution, null);
});

// EC.3: platformGuard validates expected state
test("EC.3: platformGuard validates expected state", () => {
  const exec = createAndTransition("tool_call", null);
  const wrongState = platformKernel.platformGuard(exec.execution_id, "running");
  assert.strictEqual(wrongState.allowed, false);
  assert.strictEqual(wrongState.reason, "wrong_state");
  assert.strictEqual(wrongState.actual, "created");
  assert.strictEqual(wrongState.expected, "running");
  const correctState = platformKernel.platformGuard(exec.execution_id, "created");
  assert.strictEqual(correctState.allowed, true);
  platformKernel.transitionExecution(exec.execution_id, "cancelled", { source: "test" });
});

// EC.4: platformGuard blocks transitions from terminal states
test("EC.4: platformGuard blocks terminal state transitions", () => {
  const exec = createAndTransition("tool_call", "completed");
  const guard = platformKernel.platformGuard(exec.execution_id, null);
  assert.strictEqual(guard.allowed, false);
  assert.strictEqual(guard.reason, "terminal_state");
  assert.strictEqual(guard.actual, "completed");
});

// EC.5: platformGuard allows terminal transitions with allowTerminal flag
test("EC.5: platformGuard allows terminal with allowTerminal", () => {
  const exec = createAndTransition("approval_request", "awaiting_approval");
  platformKernel.transitionExecution(exec.execution_id, "timed_out", { source: "test" });
  const guard = platformKernel.platformGuard(exec.execution_id, null, { allowTerminal: true });
  assert.strictEqual(guard.allowed, true);
});

// EC.6: platformGuard returns execution_not_found for missing ID
test("EC.6: platformGuard returns execution_not_found", () => {
  const guard = platformKernel.platformGuard("exec_nonexistent", null);
  assert.strictEqual(guard.allowed, false);
  assert.strictEqual(guard.reason, "execution_not_found");
});

// EC.7: findActiveExecution filters by operation_type
test("EC.7: findActiveExecution filters by operation_type", () => {
  const exec1 = createAndTransition("cron_job", "queued");
  const exec2 = createAndTransition("delay_task", "queued");
  const cronJobs = platformKernel.findActiveExecution({ operation_type: "cron_job" });
  assert.strictEqual(cronJobs.length, 1);
  assert.strictEqual(cronJobs[0].execution_id, exec1.execution_id);
  const delayTasks = platformKernel.findActiveExecution({ operation_type: "delay_task" });
  assert.strictEqual(delayTasks.length, 1);
  assert.strictEqual(delayTasks[0].execution_id, exec2.execution_id);
  platformKernel.transitionExecution(exec1.execution_id, "cancelled", { source: "test" });
  platformKernel.transitionExecution(exec2.execution_id, "cancelled", { source: "test" });
});

// EC.8: findActiveExecution excludes terminal states
test("EC.8: findActiveExecution excludes terminal states", () => {
  const exec = createAndTransition("watch_check", "completed");
  const active = platformKernel.findActiveExecution({ operation_type: "watch_check" });
  assert.strictEqual(active.length, 0);
});

// EC.9: findActiveExecution filters by tool_name
test("EC.9: findActiveExecution filters by tool_name", () => {
  const exec = createAndTransition("tool_call", "running", { tool_name: "sidekick_bash" });
  const bash = platformKernel.findActiveExecution({ tool_name: "sidekick_bash" });
  assert.strictEqual(bash.length, 1);
  const other = platformKernel.findActiveExecution({ tool_name: "sidekick_github" });
  assert.strictEqual(other.length, 0);
  platformKernel.transitionExecution(exec.execution_id, "completed", { source: "test" });
});

// EC.10: State machine rejects out-of-order transitions
test("EC.10: State machine rejects out-of-order transitions", () => {
  const exec = createAndTransition("tool_call", null);
  assert.throws(() => {
    platformKernel.transitionExecution(exec.execution_id, "completed", { source: "test" });
  }, /Invalid execution transition/);
  platformKernel.transitionExecution(exec.execution_id, "cancelled", { source: "test" });
});

// EC.11: State machine rejects transitions from terminal states
test("EC.11: State machine rejects transitions from terminal", () => {
  const exec = createAndTransition("tool_call", "completed");
  assert.throws(() => {
    platformKernel.transitionExecution(exec.execution_id, "running", { source: "test" });
  }, /Invalid execution transition/);
});

// EC.12: findActiveExecution filters by metadata_key
test("EC.12: findActiveExecution filters by metadata", () => {
  const exec = platformKernel.createExecution({
    operation_type: "delay_task",
    state: "created",
    source: "test",
    metadata: { kind: "delay", id: "delay-abc-123" },
  });
  platformKernel.transitionExecution(exec.execution_id, "queued", { source: "test" });
  const found = platformKernel.findActiveExecution({ metadata_key: "id", metadata_value: "delay-abc-123" });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].execution_id, exec.execution_id);
  platformKernel.transitionExecution(exec.execution_id, "cancelled", { source: "test" });
});

// EC.13: TERMINAL_STATES is exported and complete
test("EC.13: TERMINAL_STATES is exported and complete", () => {
  assert.ok(platformKernel.TERMINAL_STATES instanceof Set);
  assert.ok(platformKernel.TERMINAL_STATES.has("completed"));
  assert.ok(platformKernel.TERMINAL_STATES.has("failed"));
  assert.ok(platformKernel.TERMINAL_STATES.has("cancelled"));
  assert.ok(platformKernel.TERMINAL_STATES.has("timed_out"));
  assert.ok(platformKernel.TERMINAL_STATES.has("rolled_back"));
  assert.ok(platformKernel.TERMINAL_STATES.has("rollback_failed"));
  assert.ok(platformKernel.TERMINAL_STATES.has("partial"));
});

// EC.14: platformGuard with allowConcurrent returns active list
test("EC.14: platformGuard with allowConcurrent returns active list", () => {
  const exec = createAndTransition("tool_call", "running", { tool_name: "sidekick_bash" });
  const guard = platformKernel.platformGuard(null, null, {
    operation_type: "tool_call",
    tool_name: "sidekick_bash",
    allowConcurrent: true,
  });
  assert.strictEqual(guard.allowed, true);
  assert.ok(Array.isArray(guard.active));
  assert.strictEqual(guard.active.length, 1);
  platformKernel.transitionExecution(exec.execution_id, "completed", { source: "test" });
});

// EC.15: platformGuard with no query returns allowed
test("EC.15: platformGuard with no query returns allowed", () => {
  const guard = platformKernel.platformGuard(null, null, {});
  assert.strictEqual(guard.allowed, true);
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
