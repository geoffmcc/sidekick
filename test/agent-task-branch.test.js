"use strict";
const assert = require("assert");
process.env.NODE_ENV = "test";
const { prepareTaskBranch } = require("../src/agent");

const task = {
  task_id: "agt_branch01",
  project_id: "sidekick",
  workspace_ref: "workspace:sidekick",
  actor_principal_id: null,
  requested_by_principal_id: null,
  authority_envelope: {
    permitted_projects: [], permitted_workspaces: [], permitted_repositories: [],
    allowed_effects: ["read_only", "workspace_reversible"],
    prohibited_effects: ["destructive", "production", "credential", "identity", "policy"],
    capability_restrictions: [], environmental_scope: [], changes_allowed: true,
    external_effects_allowed: false, production_allowed: false,
    approval_threshold: "high", rollback_expectation: "attempt_if_safe",
    child_task_depth: 1, child_task_count: 1, concurrency_limit: 1, expires_at: null,
  },
};
const descriptor = { name: "git", version: "git-test-v1", risk: "medium", annotations: {} };

function harness(dispatchResponses) {
  const calls = [];
  const receipts = [];
  const usage = [];
  let receiptNumber = 0;
  return {
    calls, receipts, usage,
    dispatch: async (name, args) => { calls.push({ name, args }); return dispatchResponses[calls.length - 1]; },
    receiptStore: {
      createReceipt: input => { const receipt = { receipt_id: `receipt_${++receiptNumber}`, ...input }; receipts.push({ receipt, transitions: [] }); return receipt; },
      transitionReceipt: (id, state, patch) => { const row = receipts.find(item => item.receipt.receipt_id === id); row.transitions.push({ state, patch }); return row.receipt; },
    },
    taskStore: { incrementUsage: (taskId, delta, event) => usage.push({ taskId, delta, event }) },
  };
}

(async () => {
  const existing = harness([
    { content: [{ type: "text", text: "  sidekick/agent/agt_branch01\n" }] },
    { content: [{ type: "text", text: "Switched to branch 'sidekick/agent/agt_branch01'" }] },
  ]);
  const result = await prepareTaskBranch({ task, repoPath: "C:/governed/repo", statusEvidence: "On branch main\nnothing to commit, working tree clean", dispatch: existing.dispatch, receiptStore: existing.receiptStore, taskStore: existing.taskStore, descriptorResolver: () => descriptor });
  assert.deepStrictEqual(result, { branch: "sidekick/agent/agt_branch01", existing: true, provider_receipt_ref: null });
  assert.strictEqual(existing.calls[1].args.args, "sidekick/agent/agt_branch01");
  assert.deepStrictEqual(existing.receipts[0].transitions.map(row => row.state), ["dispatched", "finalized"]);
  assert.deepStrictEqual(existing.usage.map(row => row.event), ["task.task_branch_inspected", "task.task_branch_created"]);

  const dirty = harness([]);
  await assert.rejects(() => prepareTaskBranch({ task, repoPath: "C:/governed/repo", statusEvidence: "On branch main\n M unrelated.txt", dispatch: dirty.dispatch, receiptStore: dirty.receiptStore, taskStore: dirty.taskStore, descriptorResolver: () => descriptor }), /pre-existing worktree changes/);
  assert.strictEqual(dirty.calls.length, 0);
  console.log("Agent task branch preparation: passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
