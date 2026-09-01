"use strict";
const assert = require("assert");
const { recoverDurableAgentTasks } = require("../src/agent/recovery-scan");
const calls = [];
const tasks = new Map([[
  "task_1", { task_id: "task_1", state: "running", checkpoint: { version: 1, safe_boundary: "after_read", next_action: "resume" } }
]]);
const kernel = {
  recoverOrphanedExecutions: () => ({ scanned: 2, orphaned: ["exec_1", "exec_1_duplicate"] }),
  getExecution: executionId => ({ execution_id: executionId, task_id: "task_1" }),
  getExecutionClaim: () => ({ checkpoint: { version: 1, safe_boundary: "after_read", next_action: "resume" } }),
};
const store = { getTask: id => tasks.get(id), updateTask: (id, patch, event) => { calls.push({ id, patch, event }); tasks.set(id, { ...tasks.get(id), ...patch }); } };
(async () => {
  const result = await recoverDurableAgentTasks({ platformKernel: kernel, taskStore: store, now: () => "2026-01-01T00:00:00.000Z" });
  assert.deepStrictEqual(result.recovered, ["task_1"]);
  assert.strictEqual(calls.length, 1, "duplicate orphan claims must recover a task only once per scan");
  assert.strictEqual(calls[0].event, "task.recovered");
  assert.strictEqual(calls[0].patch.state, "interrupted");

  const receipt = { receipt_id: "receipt_1", task_id: "task_1", outcome_state: "dispatched", dispatch_state: "dispatched", action_fingerprint: "fp", capability: "safe_write", idempotency_class: "idempotent" };
  const receiptCalls = [];
  const receiptStore = {
    listReceipts: () => [receipt],
    evaluateRecovery: () => ({ decision: "retry", reason: "fresh absence" }),
    transitionReceipt: (id, state) => receiptCalls.push([id, state]),
  };
  const completed = [];
  const retryResult = await recoverDurableAgentTasks({
    platformKernel: kernel,
    taskStore: { ...store, recordCompletedOperation: (...args) => completed.push(args) },
    receiptStore,
    inspectReceipt: async () => ({ postcondition: "absent", targetState: "observed", authorityAllowsRetry: true, policyAllowsRetry: true }),
    retryReceipt: async () => ({ ok: true, provider_receipt_ref: "provider-retry" }),
  });
  assert.deepStrictEqual(retryResult.recovered, ["task_1"]);
  assert.deepStrictEqual(receiptCalls, [["receipt_1", "finalized"], ["receipt_1", "verified"]]);
  assert.strictEqual(completed.length, 1);

  const finalizedReceipt = { receipt_id: "receipt_finalized", task_id: "task_1", outcome_state: "finalized", dispatch_state: "finalized", action_fingerprint: "fp_finalized", capability: "safe_write", provider_receipt_ref: "provider-before-crash" };
  let retryCalled = false;
  const finalizedTransitions = [];
  const finalizedResult = await recoverDurableAgentTasks({
    platformKernel: kernel,
    taskStore: { ...store, recordCompletedOperation: (...args) => completed.push(args) },
    receiptStore: {
      listReceipts: () => [finalizedReceipt],
      transitionReceipt: (id, state) => finalizedTransitions.push([id, state]),
      evaluateRecovery: () => ({ decision: "escalate" }),
    },
    inspectReceipt: async () => { throw new Error("finalized receipt must not be inspected or dispatched"); },
    retryReceipt: async () => { retryCalled = true; return { ok: true }; },
  });
  assert.strictEqual(retryCalled, false);
  assert.deepStrictEqual(finalizedTransitions, [["receipt_finalized", "verified"]]);
  assert.deepStrictEqual(finalizedResult.recovered, ["task_1"]);
  assert.ok(completed.some(args => args[1].receipt_ref === "provider-before-crash"));

  // A partial effect uses the durable rollback callback and is never replayed
  // as a fresh mutation.
  const partialReceipt = { receipt_id: "receipt_partial", task_id: "task_1", outcome_state: "dispatched", dispatch_state: "dispatched", action_fingerprint: "fp_partial", capability: "safe_write", idempotency_class: "not_idempotent", reversibility_class: "reversible" };
  const partialTransitions = [];
  let rollbackCalled = false;
  const partialResult = await recoverDurableAgentTasks({
    platformKernel: kernel,
    taskStore: { ...store, recordAmbiguousOperation: (...args) => completed.push(args) },
    receiptStore: {
      listReceipts: () => [partialReceipt],
      evaluateRecovery: () => ({ decision: "rollback", reason: "partial state" }),
      transitionReceipt: (id, state) => partialTransitions.push([id, state]),
    },
    inspectReceipt: async () => ({ postcondition: "partial", targetState: "observed", authorityAllowsRetry: true, policyAllowsRetry: true }),
    rollbackReceipt: async () => { rollbackCalled = true; return { ok: true, provider_receipt_ref: "rollback-provider" }; },
  });
  assert.strictEqual(rollbackCalled, true);
  assert.deepStrictEqual(partialTransitions, [["receipt_partial", "ambiguous"], ["receipt_partial", "rolled_back"]]);
  assert.deepStrictEqual(partialResult.recovered, ["task_1"]);

  // If verification crashes, the mutation is parked as ambiguous rather than
  // repeated from historical arguments.
  const unknownReceipt = { receipt_id: "receipt_unknown", task_id: "task_1", outcome_state: "dispatched", dispatch_state: "dispatched", action_fingerprint: "fp_unknown", capability: "unsafe_write", idempotency_class: "not_idempotent", reversibility_class: "irreversible" };
  const unknownTransitions = [];
  let unknownRetryCalled = false;
  const unknownResult = await recoverDurableAgentTasks({
    platformKernel: kernel,
    taskStore: { ...store, recordAmbiguousOperation: (...args) => completed.push(args) },
    receiptStore: {
      listReceipts: () => [unknownReceipt],
      evaluateRecovery: () => ({ decision: "escalate", reason: "verification unavailable" }),
      transitionReceipt: (id, state) => unknownTransitions.push([id, state]),
    },
    inspectReceipt: async () => { throw new Error("verification process crashed"); },
    retryReceipt: async () => { unknownRetryCalled = true; return { ok: true }; },
  });
  assert.strictEqual(unknownRetryCalled, false);
  assert.deepStrictEqual(unknownTransitions, [["receipt_unknown", "ambiguous"]]);
  assert.deepStrictEqual(unknownResult.failed, ["task_1"]);
  console.log("Agent recovery scan: passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
