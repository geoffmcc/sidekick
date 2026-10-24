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

test("capability verification cannot claim another actor or self-attested evidence roles", async () => {
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
  assert.throws(() => lifecycle.recordVerification(installed.pack.name, {
    actor_ref: verifier.principal_id,
    project_ref: "pack-proving-evidence",
    evidence_refs,
  }), /server-verifiable evidence source/);
  const saved = db.getDb().prepare("SELECT COUNT(*) AS count FROM platform_pack_verification_evidence WHERE pack_name = ?").get(installed.pack.name);
  assert.equal(saved.count, 0, "caller-assigned role labels must not persist as verification evidence");
});

test("pack evidence rejects a non-terminal execution reference", () => {
  const task = taskStore.insertTask(taskModel.createTask({ objective: "non-terminal evidence fixture", project_id: "pack-proving-evidence", actor_id: "test", actor_principal_id: "test-principal" }));
  const receipt = receiptStore.createReceipt({ task_id: task.task_id, action_fingerprint: "non-terminal-evidence-fingerprint", capability: "api_contract_check", args: { url: "https://example.test" }, project_ref: "pack-proving-evidence", principal_ref: "test-principal", effect_class: "read_only", risk_class: "low" });
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      project_ref: "pack-proving-evidence",
      evidence_refs: [{ type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" }],
    }),
    /not terminal/
  );
});

test("pack evidence rejects a caller-claimed unsupported certification role", () => {
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
    principal_ref: "test-principal",
    effect_class: "read_only",
    risk_class: "low",
  });
  receiptStore.transitionReceipt(receipt.receipt_id, "dispatched");
  receiptStore.transitionReceipt(receipt.receipt_id, "finalized");
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      project_ref: "pack-proving-evidence",
      evidence_refs: [
        { type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" },
        { type: "receipt", id: receipt.receipt_id, role: "single_pack" },
      ],
    }),
    /no server-verifiable evidence source/
  );
});

test("pack evidence rejects duplicated references even when the role is unchanged", () => {
  const task = taskStore.insertTask(taskModel.createTask({ objective: "duplicate evidence fixture", project_id: "pack-proving-evidence", actor_id: "test", actor_principal_id: "test-principal" }));
  const receipt = receiptStore.createReceipt({ task_id: task.task_id, action_fingerprint: "duplicate-evidence-fingerprint", capability: "api_contract_check", args: { url: "https://example.test" }, project_ref: "pack-proving-evidence", principal_ref: "test-principal", effect_class: "read_only", risk_class: "low" });
  receiptStore.transitionReceipt(receipt.receipt_id, "dispatched");
  receiptStore.transitionReceipt(receipt.receipt_id, "finalized");
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      project_ref: "pack-proving-evidence",
      evidence_refs: [
        { type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" },
        { type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" },
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
    principal_ref: "test-principal",
    effect_class: "read_only",
    risk_class: "low",
  });
  receiptStore.transitionReceipt(receipt.receipt_id, "dispatched");
  receiptStore.transitionReceipt(receipt.receipt_id, "finalized");
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      project_ref: "pack-proving-evidence",
      evidence_refs: [{ type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" }],
    }),
    /outside pack ownership/
  );
});

test("pack evidence cannot be attributed across principals or projects", () => {
  const task = taskStore.insertTask(taskModel.createTask({
    objective: "foreign evidence fixture",
    project_id: "other-pack-proving-project",
    actor_id: "other-principal",
    actor_principal_id: "other-principal",
  }));
  const receipt = receiptStore.createReceipt({
    task_id: task.task_id,
    action_fingerprint: "foreign-pack-evidence-fingerprint",
    capability: "api_contract_check",
    args: { url: "https://example.test" },
    project_ref: "other-pack-proving-project",
    principal_ref: "other-principal",
    effect_class: "read_only",
    risk_class: "low",
  });
  receiptStore.transitionReceipt(receipt.receipt_id, "dispatched");
  receiptStore.transitionReceipt(receipt.receipt_id, "finalized");
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      project_ref: "pack-proving-evidence",
      evidence_refs: [{ type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" }],
    }),
    /not performed by the attributed verifier/
  );
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "other-principal",
      project_ref: "pack-proving-evidence",
      evidence_refs: [{ type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" }],
    }),
    /belongs to a different project/
  );
});

test("pack evidence enforces verifier ownership and rejects unproven execution sources", () => {
  const execution = platformKernel.createExecution({
    project_id: "pack-proving-evidence",
    actor_id: "other-principal",
    actor_principal_id: "other-principal",
    operation_type: "pack_proving",
    source: "test",
  });
  platformKernel.transitionExecution(execution.execution_id, "running", { source: "test", actor_id: "other-principal" });
  platformKernel.transitionExecution(execution.execution_id, "completed", { source: "test", actor_id: "other-principal" });
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      project_ref: "pack-proving-evidence",
      evidence_refs: [{ type: "execution", id: execution.execution_id, role: "canonical_dispatch" }],
    }),
    /cannot substantiate verification role canonical_dispatch/
  );

  const workflow = platformKernel.createWorkflow({
    name: "foreign verification workflow",
    project_id: "pack-proving-evidence",
    actor_principal_id: "other-principal",
    steps: [],
  });
  platformKernel.startWorkflow(workflow.workflow_id, { source: "test", actor_id: "other-principal" });
  platformKernel.advanceWorkflow(workflow.workflow_id, { source: "test", actor_id: "other-principal" });
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      project_ref: "pack-proving-evidence",
      evidence_refs: [{ type: "workflow", id: workflow.workflow_id, role: "workflow" }],
    }),
    /not performed by the attributed verifier/
  );
});

test("pack workflow evidence must reference a workflow owned by the pack", () => {
  const workflow = platformKernel.createWorkflow({
    name: "unrelated workflow",
    project_id: "pack-proving-evidence",
    actor_principal_id: "test-principal",
    steps: [],
  });
  platformKernel.startWorkflow(workflow.workflow_id, { source: "test", actor_id: "test-principal" });
  platformKernel.advanceWorkflow(workflow.workflow_id, { source: "test", actor_id: "test-principal" });
  assert.throws(() => lifecycle.recordVerification(installed.pack.name, {
    actor_ref: "test-principal",
    project_ref: "pack-proving-evidence",
    evidence_refs: [{ type: "workflow", id: workflow.workflow_id, role: "workflow" }],
  }), /not owned by pack/);
});

test("provider integration cannot be self-attested with a caller-supplied boolean", () => {
  assert.throws(
    () => lifecycle.recordVerification(installed.pack.name, {
      actor_ref: "test-principal",
      project_ref: "pack-proving-evidence",
      provider: { verified: true, provider_id: "synthetic-provider" },
      evidence_refs: [{ type: "execution", id: "caller-chosen", role: "provider_integration" }],
    }),
    error => error.code === "provider_evidence_unavailable" && /server-verifiable provider receipt is not available/.test(error.message)
  );
  const maturity = lifecycle.maturity(installed.pack.name);
  assert.equal(maturity.provider_verified, false);
  assert.equal(maturity.optional_provider_integration, "not_verified");
});
