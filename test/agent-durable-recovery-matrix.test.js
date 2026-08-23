"use strict";

// Durable integration matrix: the task and receipt stores are real SQLite
// stores. Only the platform claim ledger and governed capability calls are
// injected, so each scenario exercises the production recovery state machine
// without touching an external provider or filesystem.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-agent-recovery-matrix-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = data;
process.env.SIDEKICK_SECRET_KEY_FILE = path.join(data, "secret");
fs.writeFileSync(process.env.SIDEKICK_SECRET_KEY_FILE, "test-only-key");

const { createTask } = require("../src/agent/task-model");
const tasks = require("../src/agent/task-store");
const receipts = require("../src/agent/receipt-store");
const { recoverDurableAgentTasks } = require("../src/agent/recovery-scan");

const taskIds = [];
function addTask(suffix) {
  const task = createTask({ task_id: `agt_matrix_${suffix}`, objective: `recovery ${suffix}`, profile: "standard", checkpoint: { version: 1, safe_boundary: "before_tool", next_action: "resume" } });
  tasks.insertTask(task);
  tasks.updateTask(task.task_id, { state: "planning", phase: "execution" }, "matrix.planning");
  tasks.updateTask(task.task_id, { state: "ready", phase: "execution" }, "matrix.ready");
  tasks.updateTask(task.task_id, { state: "running", phase: "execution" }, "matrix.running");
  taskIds.push(task.task_id);
  return task;
}
function kernelFor(taskId) {
  const executionId = `exec_${taskId}`;
  return {
    recoverOrphanedExecutions: () => ({ scanned: 1, orphaned: [executionId] }),
    getExecution: () => ({ execution_id: executionId, task_id: taskId }),
    getExecutionClaim: () => ({ checkpoint: { version: 1, safe_boundary: "before_tool", next_action: "resume" } }),
  };
}
function receipt(task, suffix, extra = {}) {
  return receipts.createReceipt({ task_id: task.task_id, action_fingerprint: `matrix-${suffix}`, capability: `matrix_${suffix}`, args: { target_ref: `workspace:matrix_${suffix}` }, ...extra });
}
async function recover(task, receiptStore = receipts, hooks = {}) {
  return recoverDurableAgentTasks({ platformKernel: kernelFor(task.task_id), taskStore: tasks, receiptStore, now: () => "2026-01-01T00:00:00.000Z", ...hooks });
}

(async () => {
  // Crash before dispatch: no receipt is replayed; the safe checkpoint is
  // restored as an interrupted durable task.
  const before = addTask("before");
  const prepared = receipt(before, "before", { idempotency_class: "idempotent", reversibility_class: "reversible" });
  const beforeResult = await recover(before);
  assert.deepStrictEqual(beforeResult.recovered, [before.task_id]);
  assert.strictEqual(receipts.getReceipt(prepared.receipt_id).dispatch_state, "prepared");
  assert.strictEqual(tasks.getTask(before.task_id).state, "interrupted");

  // Crash during dispatch, definitely absent: a single governed retry is
  // allowed and the receipt is finalized/verified without a second recovery.
  const absent = addTask("absent");
  const absentReceipt = receipt(absent, "absent", { idempotency_class: "idempotent", reversibility_class: "reversible" });
  receipts.transitionReceipt(absentReceipt.receipt_id, "dispatched");
  let retryCalls = 0;
  const absentResult = await recover(absent, receipts, {
    inspectReceipt: async () => ({ postcondition: "absent", targetState: "observed", authorityAllowsRetry: true, policyAllowsRetry: true }),
    retryReceipt: async () => { retryCalls++; return { ok: true, provider_receipt_ref: "retry_receipt" }; },
  });
  assert.deepStrictEqual(absentResult.recovered, [absent.task_id]);
  assert.strictEqual(retryCalls, 1);
  assert.strictEqual(receipts.getReceipt(absentReceipt.receipt_id).dispatch_state, "verified");

  // Crash after the side effect but before receipt finalization: fresh
  // postcondition evidence marks it verified and never invokes retry.
  const sideEffect = addTask("side_effect");
  const sideReceipt = receipt(sideEffect, "side_effect", { idempotency_class: "not_idempotent", reversibility_class: "irreversible" });
  receipts.transitionReceipt(sideReceipt.receipt_id, "dispatched");
  let sideRetryCalls = 0;
  const sideResult = await recover(sideEffect, receipts, {
    inspectReceipt: async () => ({ postcondition: "satisfied", targetState: "observed", evidence_ref: "fresh_side_effect" }),
    retryReceipt: async () => { sideRetryCalls++; return { ok: true }; },
  });
  assert.deepStrictEqual(sideResult.recovered, [sideEffect.task_id]);
  assert.strictEqual(sideRetryCalls, 0);
  assert.strictEqual(receipts.getReceipt(sideReceipt.receipt_id).dispatch_state, "verified");

  // Crash after receipt finalization but before the task checkpoint: the
  // durable receipt is folded into task lineage without inspection/replay.
  const finalized = addTask("finalized");
  const finalizedReceipt = receipt(finalized, "finalized", { idempotency_class: "not_idempotent", reversibility_class: "irreversible" });
  receipts.transitionReceipt(finalizedReceipt.receipt_id, "dispatched");
  receipts.transitionReceipt(finalizedReceipt.receipt_id, "finalized", { provider_receipt_ref: "provider_final" });
  let finalizedInspection = 0;
  const finalizedResult = await recover(finalized, receipts, { inspectReceipt: async () => { finalizedInspection++; throw new Error("must not inspect finalized receipt"); }, retryReceipt: async () => { throw new Error("must not retry finalized receipt"); } });
  assert.deepStrictEqual(finalizedResult.recovered, [finalized.task_id]);
  assert.strictEqual(finalizedInspection, 0);
  assert.strictEqual(receipts.getReceipt(finalizedReceipt.receipt_id).dispatch_state, "verified");

  // Verification crash / ambiguous mutation: park it and never retry.
  const ambiguous = addTask("ambiguous");
  const ambiguousReceipt = receipt(ambiguous, "ambiguous", { idempotency_class: "not_idempotent", reversibility_class: "irreversible" });
  receipts.transitionReceipt(ambiguousReceipt.receipt_id, "dispatched");
  let ambiguousRetryCalls = 0;
  const ambiguousResult = await recover(ambiguous, receipts, { inspectReceipt: async () => { throw new Error("verification crashed"); }, retryReceipt: async () => { ambiguousRetryCalls++; return { ok: true }; } });
  assert.deepStrictEqual(ambiguousResult.failed, [ambiguous.task_id]);
  assert.strictEqual(ambiguousRetryCalls, 0);
  assert.strictEqual(receipts.getReceipt(ambiguousReceipt.receipt_id).dispatch_state, "ambiguous");

  // Partial effect with an eligible durable rollback: rollback is recorded as
  // a distinct receipt transition and the original mutation is not repeated.
  const partial = addTask("partial");
  const partialReceipt = receipt(partial, "partial", { idempotency_class: "not_idempotent", reversibility_class: "reversible" });
  receipts.transitionReceipt(partialReceipt.receipt_id, "dispatched");
  let rollbackCalls = 0;
  const partialResult = await recover(partial, receipts, {
    inspectReceipt: async () => ({ postcondition: "partial", targetState: "observed", authorityAllowsRetry: true, policyAllowsRetry: true }),
    rollbackReceipt: async () => { rollbackCalls++; return { ok: true, provider_receipt_ref: "rollback_final" }; },
  });
  assert.deepStrictEqual(partialResult.recovered, [partial.task_id]);
  assert.strictEqual(rollbackCalls, 1);
  assert.strictEqual(receipts.getReceipt(partialReceipt.receipt_id).dispatch_state, "rolled_back");

  console.log("Agent durable recovery matrix: passed (before-dispatch, absent-retry, post-effect, finalized, verification-crash, partial-rollback)");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
});
