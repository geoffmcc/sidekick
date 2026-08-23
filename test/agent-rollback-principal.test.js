"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const data = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-agent-rollback-principal-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = data;
process.env.SIDEKICK_SECRET_KEY_FILE = path.join(data, "secret");
fs.writeFileSync(process.env.SIDEKICK_SECRET_KEY_FILE, "test-only-key");

const workspace = require("../src/agent/workspace-transactions");
const { createTask } = require("../src/agent/task-model");
const taskStore = require("../src/agent/task-store");
const { createAuthorityEnvelope } = require("../src/agent/authority");

taskStore.insertTask(createTask({ task_id: "agt_principal_rollback", objective: "rollback principal propagation", profile: "standard", project_id: "project:test", workspace_ref: "workspace:test", actor_principal_id: "principal:test", requested_by_principal_id: "principal:test" }));

(async () => {
  const transaction = workspace.createTransaction({
    task_id: "agt_principal_rollback",
    workspace_ref: "workspace:test",
    target_ref: "workspace:test",
    affected_resources: ["workspace:test"],
    mutation_capability: "git",
    mutation_args_digest: "digest",
  });
  workspace.markRollbackEligible(transaction.transaction_id, "git", "artifact:rollback", { action: "status", path: "workspace:test" });
  const calls = [];
  const result = await workspace.executeRollback({
    transactionId: transaction.transaction_id,
    task: {
      task_id: "agt_principal_rollback",
      project_id: "project:test",
      workspace_ref: "workspace:test",
      actor_principal_id: "principal:test",
      authority_envelope: createAuthorityEnvelope({
        allowed_effects: ["read_only", "workspace_reversible"],
        changes_allowed: true,
        child_task_depth: 0,
        child_task_count: 0,
        concurrency_limit: 1,
      }),
    },
    registry: { get: name => ({ name, annotations: { readOnlyHint: true }, version: "test" }) },
    authIdentity: { principal_id: "principal:test", scopes: [], delegation_id: null },
    callAgentTool: async (name, args, options) => {
      calls.push({ name, args, options });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  assert.strictEqual(result.state, "rolled_back");
  assert.strictEqual(calls[0].options.authIdentity.principal_id, "principal:test");

  const second = workspace.createTransaction({ task_id: "agt_principal_rollback", workspace_ref: "workspace:test", target_ref: "workspace:test", mutation_capability: "git", mutation_args_digest: "digest" });
  workspace.markRollbackEligible(second.transaction_id, "git", "artifact:rollback", { action: "status" });
  await assert.rejects(() => workspace.executeRollback({
    transactionId: second.transaction_id,
    task: { task_id: "agt_principal_rollback", project_id: "project:test", workspace_ref: "workspace:test", actor_principal_id: "principal:test", authority_envelope: createAuthorityEnvelope({ allowed_effects: ["read_only", "workspace_reversible"], changes_allowed: true }) },
    registry: { get: name => ({ name, annotations: { readOnlyHint: true }, version: "test" }) },
    callAgentTool: async () => ({ content: [{ type: "text", text: "must not dispatch" }] }),
  }), /authenticated task principal/);
  console.log("Agent rollback principal propagation: passed");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch {} });
