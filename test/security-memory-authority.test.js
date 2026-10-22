"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-memory-authority-"));
process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const projectAccess = require("../src/core/project-access");
const platformKernel = require("../src/platform/kernel");
const dispatcher = require("../src/tools/dispatcher");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");

const owner = identity.bootstrapOwner({ username: "memory_authority_owner", password: "synthetic sufficiently long password" });
const operator = identity.createHumanUser({ username: "memory_authority_operator", password: "synthetic sufficiently long password" });
identity.assignRole(operator.principal_id, "operator", owner.principal_id);
platformKernel.registerProject({ project_id: "memory_authority_project", owner_actor_id: owner.principal_id });
projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_authority_project", accessLevel: "write" });
const registry = getCanonicalRegistry();
const memory = registry.get("memory");
const memoryManage = registry.get("memory_manage");

test.after(() => {
  db.closeDatabase();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("caller-supplied memory source cannot promote authority", async () => {
  const result = await dispatcher.dispatchTestTool({
    descriptor: memory,
    args: { action: "remember", project: "memory_authority_project", content: "synthetic unverified claim", source: "user_correction" },
    context: { authIdentity: { principal_id: operator.principal_id, principal_type: "human" }, project: "memory_authority_project" },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = JSON.parse(result.content[0].text);
  const stored = db.getMemoryById(payload.memory.id, { includeDisabled: true });
  assert.equal(stored.source, "explicit");
  assert.equal(stored.source_authority, 5);
  assert.equal(stored.metadata.requested_source, "user_correction");
});

test("project write access cannot correct or confirm high-authority memory", async () => {
  const original = db.upsertMemory({ type: "fact", project: "memory_authority_project", content: "original synthetic fact", summary: "original synthetic fact", source: "explicit", source_authority: 5, requires_confirmation: true });
  assert.equal(dispatcher.requiredToolPermission(memory, { action: "correct" }), "tools.execute_critical");
  assert.equal(dispatcher.requiredToolPermission(memory, { action: "confirm" }), "tools.execute_critical");
  assert.equal(dispatcher.requiredToolPermission(memoryManage, { action: "confirm" }), "tools.execute_critical");

  const context = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" }, project: "memory_authority_project" };
  const correction = await dispatcher.dispatchTestTool({ descriptor: memory, args: { action: "correct", id: original.id, correct_to: "forged corrected fact", project: "memory_authority_project" }, context });
  const confirm = await dispatcher.dispatchTestTool({ descriptor: memory, args: { action: "confirm", id: original.id, project: "memory_authority_project", source: "forged-principal" }, context });
  const lifecycleConfirm = await dispatcher.dispatchTestTool({ descriptor: memoryManage, args: { action: "confirm", id: original.id, project: "memory_authority_project", confirmed_by: "forged-principal" }, context });

  for (const denied of [correction, confirm, lifecycleConfirm]) {
    assert.equal(denied.isError, true);
    assert.equal(denied.code, "authorization_denied");
  }
  const unchanged = db.getMemoryById(original.id, { includeDisabled: true });
  assert.equal(unchanged.state, "pending");
  assert.equal(unchanged.content, "original synthetic fact");
  assert.equal(unchanged.confirmed_by, null);
});

test("authorized confirmation records the authenticated principal, not caller text", async () => {
  const pending = db.upsertMemory({ type: "fact", project: "memory_authority_project", content: "owner reviewed synthetic claim", summary: "owner reviewed synthetic claim", source: "explicit", requires_confirmation: true });
  const result = await dispatcher.dispatchTestTool({
    descriptor: memoryManage,
    args: { action: "confirm", id: pending.id, project: "memory_authority_project", confirmed_by: "forged-principal" },
    context: { authIdentity: { principal_id: owner.principal_id, principal_type: "human" }, project: "memory_authority_project" },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(db.getMemoryById(pending.id, { includeDisabled: true }).confirmed_by, owner.principal_id);
});

test("failed replacement persistence rolls back the old-memory deletion", async () => {
  const original = db.upsertMemory({ type: "fact", project: "memory_authority_project", content: "atomic correction original", summary: "atomic correction original", source: "explicit", source_authority: 5 });
  const upsertMemory = db.upsertMemory;
  db.upsertMemory = () => { throw new Error("synthetic replacement write failure"); };
  try {
    const result = await dispatcher.dispatchTestTool({
      descriptor: memory,
      args: { action: "correct", id: original.id, correct_to: "replacement that must not persist", project: "memory_authority_project" },
      context: { authIdentity: { principal_id: owner.principal_id, principal_type: "human" }, project: "memory_authority_project" },
    });
    assert.equal(result.isError, true);
  } finally {
    db.upsertMemory = upsertMemory;
  }
  const unchanged = db.getMemoryById(original.id, { includeDisabled: true });
  assert.equal(unchanged.state, "active");
  assert.equal(unchanged.content, "atomic correction original");
  assert.equal(db.searchMemories({ project: "memory_authority_project", query: "replacement that must not persist", includeDisabled: true }).length, 0);
});
