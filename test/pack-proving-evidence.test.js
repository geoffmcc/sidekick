"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-pack-proving-evidence-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "pack-proving-evidence-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const bundled = require("../src/packs/bundled");
const lifecycle = require("../src/packs/lifecycle");
const identity = require("../src/core/identity");
const tools = require("../src/tools");
const platformKernel = require("../src/platform/kernel");
const taskModel = require("../src/agent/task-model");
const taskStore = require("../src/agent/task-store");
const receiptStore = require("../src/agent/receipt-store");

const installed = bundled.installBundledPack("api-engineering");

test("capability verification cannot claim a different authenticated actor", async () => {
  const verifier = identity.bootstrapOwner({
    username: "pack_verifier",
    password: "synthetic pack verification test password",
  });
  const result = await tools.callDashboardTool("capability", {
    action: "record_verification",
    name: installed.pack.name,
    config: { actor_ref: "forged-principal", evidence_refs: [] },
  }, {
    authIdentity: { principal_id: verifier.principal_id, principal_type: "human", scopes: null },
  });
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.ok, false);
  assert.equal(response.code, "verification_actor_mismatch");

  const roles = ["canonical_dispatch", "agent_discovery", "workflow", "single_pack", "cross_pack", "skeptical_verification"];
  const evidence_refs = roles.map(role => {
    const execution = platformKernel.createExecution({
      project_id: "pack-proving-evidence",
      actor_id: verifier.principal_id,
      actor_principal_id: verifier.principal_id,
      operation_type: "pack_proving",
      source: "test",
    });
    platformKernel.transitionExecution(execution.execution_id, "running", { source: "test", actor_id: verifier.principal_id });
    platformKernel.transitionExecution(execution.execution_id, "completed", { source: "test", actor_id: verifier.principal_id });
    return { type: "execution", id: execution.execution_id, role };
  });
  const attributed = await tools.callDashboardTool("capability", {
    action: "record_verification",
    name: installed.pack.name,
    config: { project_ref: "pack-proving-evidence", evidence_refs },
  }, {
    authIdentity: { principal_id: verifier.principal_id, principal_type: "human", scopes: null },
  });
  assert.equal(JSON.parse(attributed.content[0].text).ok, true);
  const saved = db.getDb().prepare("SELECT actor_ref FROM platform_pack_verification_evidence WHERE pack_name = ? ORDER BY created_at DESC LIMIT 1").get(installed.pack.name);
  assert.equal(saved.actor_ref, verifier.principal_id, "the durable verifier identity comes from authenticated dispatch context");
});

test("pack evidence rejects a non-terminal execution reference", () => {
  const execution = platformKernel.createExecution({
    project_id: "pack-proving-evidence",
    actor_id: "test",
    actor_principal_id: "test-principal",
    operation_type: "pack_proving",
    source: "test",
  });
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      evidence_refs: [{ type: "execution", id: execution.execution_id, role: "canonical_dispatch" }],
    }),
    /not completed/
  );
});

test("pack evidence does not reuse one receipt for multiple certification roles", () => {
  const task = taskStore.insertTask(taskModel.createTask({
    objective: "pack evidence fixture",
    project_id: "pack-proving-evidence",
    actor_id: "test",
    actor_principal_id: "test-principal",
  }));
  const receipt = receiptStore.createReceipt({
    task_id: task.task_id,
    action_fingerprint: "pack-evidence-fingerprint",
    capability: "api_contract_check",
    args: { url: "https://example.test" },
    project_ref: "pack-proving-evidence",
    effect_class: "read_only",
    risk_class: "low",
  });
  receiptStore.transitionReceipt(receipt.receipt_id, "dispatched");
  receiptStore.transitionReceipt(receipt.receipt_id, "finalized");
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      evidence_refs: [
        { type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" },
        { type: "receipt", id: receipt.receipt_id, role: "single_pack" },
      ],
    }),
    /cannot support multiple verification roles/
  );
});

test("pack evidence rejects duplicated references even when the role is unchanged", () => {
  const execution = platformKernel.createExecution({
    project_id: "pack-proving-evidence",
    actor_id: "test",
    actor_principal_id: "test-principal",
    operation_type: "pack_proving",
    source: "test",
  });
  platformKernel.transitionExecution(execution.execution_id, "running", { source: "test", actor_id: "test" });
  platformKernel.transitionExecution(execution.execution_id, "completed", { source: "test", actor_id: "test" });
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      evidence_refs: [
        { type: "execution", id: execution.execution_id, role: "canonical_dispatch" },
        { type: "execution", id: execution.execution_id, role: "canonical_dispatch" },
      ],
    }),
    /duplicated for verification role/
  );
});

test("pack evidence rejects receipts for tools outside pack ownership", () => {
  const task = taskStore.insertTask(taskModel.createTask({
    objective: "foreign capability fixture",
    project_id: "pack-proving-evidence",
    actor_id: "test",
    actor_principal_id: "test-principal",
  }));
  const receipt = receiptStore.createReceipt({
    task_id: task.task_id,
    action_fingerprint: "foreign-capability-fingerprint",
    capability: "not_owned_by_api_engineering",
    args: {},
    project_ref: "pack-proving-evidence",
    effect_class: "read_only",
    risk_class: "low",
  });
  receiptStore.transitionReceipt(receipt.receipt_id, "dispatched");
  receiptStore.transitionReceipt(receipt.receipt_id, "finalized");
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      evidence_refs: [{ type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" }],
    }),
    /outside pack ownership/
  );
});
