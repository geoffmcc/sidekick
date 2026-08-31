const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, `test-data-identity-approval-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.SIDEKICK_SECRET_KEY = "identity-approval-test-key";
delete require.cache[require.resolve("../src/db")];
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const continuation = require("../src/approvals/continuation");
const store = require("../src/approvals/store");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

try {
  const owner = identity.bootstrapOwner({ username: "owner", password: "correct horse battery staple" });
  const viewer = identity.createHumanUser({ username: "viewer", password: "another correct password" });
  identity.assignRole(viewer.principal_id, "viewer", owner.principal_id);
  const administrator = identity.createHumanUser({ username: "administrator", password: "third correct password" });
  identity.assignRole(administrator.principal_id, "administrator", owner.principal_id);
  const agent = identity.createPrincipal({ type: "agent", displayName: "Build Agent", actorPrincipalId: owner.principal_id });

  const parked = continuation.park({
    taskId: "approval-governance-task",
    goal: "governed action",
    plan: { steps: [{ id: "step-1", tool: "test_tool", args: { value: "fixed" } }] },
    stepId: "step-1",
    toolName: "test_tool",
    args: { value: "fixed" },
    risk: "high",
    source: "agent",
    requesterIdentity: owner.principal_id,
    requestedByPrincipalId: owner.principal_id,
    actorPrincipalId: agent.principal_id,
    requiresHumanApproval: true,
    approvalPolicy: "human-owner-review",
  });
  assert.strictEqual(parked.ok, true);
  const approvalId = parked.approvalId;

  test("approval records stable requester, actor, policy, and action digest", () => {
    const row = store.getApproval(approvalId);
    assert.strictEqual(row.requested_by_principal_id, owner.principal_id);
    assert.strictEqual(row.actor_principal_id, agent.principal_id);
    assert.strictEqual(row.requires_human_approval, 1);
    assert.strictEqual(row.approval_policy, "human-owner-review");
    assert.ok(typeof row.args_digest === "string" && row.args_digest.length > 10);
  });

  test("viewer and agent cannot approve, and the requesting Owner cannot self-approve", () => {
    assert.strictEqual(continuation.approve({ approvalId, approverIdentity: viewer.principal_id, approverPrincipalId: viewer.principal_id }).code, "forbidden");
    assert.strictEqual(continuation.approve({ approvalId, approverIdentity: agent.principal_id, approverPrincipalId: agent.principal_id }).code, "human_approval_required");
    assert.strictEqual(continuation.approve({ approvalId, approverIdentity: owner.principal_id, approverPrincipalId: owner.principal_id }).code, "self_approval_denied");
    assert.strictEqual(store.getApproval(approvalId).status, "pending");
  });

  test("authorized human approval stores the stable approver principal", () => {
    const result = continuation.approve({ approvalId, approverIdentity: administrator.principal_id, approverPrincipalId: administrator.principal_id, now: new Date().toISOString() });
    assert.strictEqual(result.ok, true);
    const row = store.getApproval(approvalId);
    assert.strictEqual(row.approved_by_principal_id, administrator.principal_id);
    assert.strictEqual(row.status, "approved");
  });

  console.log(`Identity approval governance: ${passed} passed`);
} finally {
  try { db.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
