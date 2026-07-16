const assert = require("assert");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-capability-rbac-" + Date.now());
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

// CR.1: grantCapability creates a capability record
test("CR.1: grantCapability creates record", () => {
  const cap = platformKernel.grantCapability({
    actor_id: "agent-1",
    capability: "tool_call",
    granted_by: "admin",
  });
  assert.ok(cap.capability_id);
  assert.strictEqual(cap.actor_id, "agent-1");
  assert.strictEqual(cap.capability, "tool_call");
  assert.ok(cap.granted_at);
  assert.strictEqual(cap.revoked_at, null);
});

// CR.2: checkCapability finds active capability
test("CR.2: checkCapability finds active", () => {
  const cap = platformKernel.grantCapability({
    actor_id: "agent-2",
    capability: "deploy",
    granted_by: "admin",
  });
  const found = platformKernel.checkCapability("agent-2", "deploy");
  assert.ok(found);
  assert.strictEqual(found.capability_id, cap.capability_id);
});

// CR.3: checkCapability returns null for missing
test("CR.3: checkCapability returns null for missing", () => {
  const found = platformKernel.checkCapability("agent-999", "nonexistent");
  assert.strictEqual(found, null);
});

// CR.4: revokeCapability sets revoked_at
test("CR.4: revokeCapability sets revoked_at", () => {
  const cap = platformKernel.grantCapability({
    actor_id: "agent-3",
    capability: "write",
    granted_by: "admin",
  });
  platformKernel.revokeCapability(cap.capability_id, { revoked_by: "admin", reason: "no longer needed" });
  const found = platformKernel.checkCapability("agent-3", "write");
  assert.strictEqual(found, null);
  const revoked = dbStore.getDb().prepare("SELECT * FROM platform_capabilities WHERE capability_id = ?").get(cap.capability_id);
  assert.ok(revoked.revoked_at);
});

// CR.5: checkCapability respects expiry
test("CR.5: checkCapability respects expiry", () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  platformKernel.grantCapability({
    actor_id: "agent-4",
    capability: "read",
    granted_by: "admin",
    expires_at: past,
  });
  const found = platformKernel.checkCapability("agent-4", "read");
  assert.strictEqual(found, null);
});

// CR.6: checkCapability with project scope
test("CR.6: checkCapability with project scope", () => {
  platformKernel.grantCapability({
    actor_id: "agent-5",
    capability: "deploy",
    granted_by: "admin",
    project_id: "sidekick",
  });
  const found = platformKernel.checkCapability("agent-5", "deploy", "sidekick");
  assert.ok(found);
  const notFound = platformKernel.checkCapability("agent-5", "deploy", "other_project");
  assert.strictEqual(notFound, null);
});

// CR.7: platformGuard blocks when capability missing
test("CR.7: platformGuard blocks when capability missing", () => {
  const guard = platformKernel.platformGuard(null, null, {
    capability: "admin_only",
    actor_id: "agent-6",
  });
  assert.strictEqual(guard.allowed, false);
  assert.strictEqual(guard.reason, "missing_capability");
});

// CR.8: platformGuard allows when capability present
test("CR.8: platformGuard allows when capability present", () => {
  platformKernel.grantCapability({
    actor_id: "agent-7",
    capability: "tool_call",
    granted_by: "admin",
  });
  const guard = platformKernel.platformGuard(null, null, {
    capability: "tool_call",
    actor_id: "agent-7",
  });
  assert.strictEqual(guard.allowed, true);
});

// CR.9: createChangeSet records immutable change
test("CR.9: createChangeSet records immutable change", () => {
  const cs = platformKernel.createChangeSet({
    approval_id: "approval-test-1",
    tool_name: "sidekick_bash",
    actor_id: "reviewer-1",
    decision: "approved",
    args: { command: "ls -la" },
  });
  assert.ok(cs.change_set_id);
  assert.ok(cs.content_hash);
  assert.strictEqual(cs.decision, "approved");
  assert.strictEqual(cs.tool_name, "sidekick_bash");
});

// CR.10: verifyChangeSet validates hash
test("CR.10: verifyChangeSet validates hash", () => {
  const cs = platformKernel.createChangeSet({
    approval_id: "approval-test-2",
    tool_name: "sidekick_bash",
    actor_id: "reviewer-1",
    decision: "approved",
    args: { command: "pwd" },
  });
  const result = platformKernel.verifyChangeSet(cs.change_set_id);
  assert.strictEqual(result.valid, true);
});

// CR.11: verifyChangeSet detects tampered hash
test("CR.11: verifyChangeSet detects tampered hash", () => {
  const cs = platformKernel.createChangeSet({
    approval_id: "approval-test-3",
    tool_name: "sidekick_bash",
    actor_id: "reviewer-1",
    decision: "approved",
    args: { command: "whoami" },
  });
  dbStore.getDb().prepare("UPDATE platform_change_sets SET content_hash = 'tampered' WHERE change_set_id = ?").run(cs.change_set_id);
  const result = platformKernel.verifyChangeSet(cs.change_set_id);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "hash_mismatch");
});

// CR.12: verifyChangeSet returns not_found for missing
test("CR.12: verifyChangeSet returns not_found for missing", () => {
  const result = platformKernel.verifyChangeSet("cs_nonexistent");
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "not_found");
});

// CR.13: getChangeSetsByApproval returns all records
test("CR.13: getChangeSetsByApproval returns all records", () => {
  platformKernel.createChangeSet({ approval_id: "approval-multi", tool_name: "bash", actor_id: "r1", decision: "approved", args: {} });
  platformKernel.createChangeSet({ approval_id: "approval-multi", tool_name: "bash", actor_id: "r1", decision: "failed", args: {} });
  const all = platformKernel.getChangeSetsByApproval("approval-multi");
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].decision, "approved");
  assert.strictEqual(all[1].decision, "failed");
});

// CR.14: grantCapability emits capability.granted event
test("CR.14: grantCapability emits event", () => {
  const cap = platformKernel.grantCapability({
    actor_id: "agent-event",
    capability: "test_cap",
    granted_by: "admin",
  });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE subject_id = ? AND event_type = 'capability.granted'").all(cap.capability_id);
  assert.ok(events.length > 0);
});

// CR.15: revokeCapability emits capability.revoked event
test("CR.15: revokeCapability emits event", () => {
  const cap = platformKernel.grantCapability({
    actor_id: "agent-revoke-event",
    capability: "test_revoke",
    granted_by: "admin",
  });
  platformKernel.revokeCapability(cap.capability_id, { revoked_by: "admin", reason: "test" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE subject_id = ? AND event_type = 'capability.revoked'").all(cap.capability_id);
  assert.ok(events.length > 0);
});

// CR.16: createChangeSet emits changeset event
test("CR.16: createChangeSet emits event", () => {
  const cs = platformKernel.createChangeSet({
    approval_id: "approval-event-test",
    tool_name: "test_tool",
    actor_id: "reviewer",
    decision: "rejected",
    args: {},
  });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE subject_id = ? AND event_type = 'changeset.rejected'").all(cs.change_set_id);
  assert.ok(events.length > 0);
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
