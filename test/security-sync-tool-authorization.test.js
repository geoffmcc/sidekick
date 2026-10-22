"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-sync-tool-auth-"));
process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const dispatcher = require("../src/tools/dispatcher");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");

const owner = identity.bootstrapOwner({ username: "sync_tools_owner", password: "synthetic sufficiently long password" });
const operator = identity.createHumanUser({ username: "sync_tools_operator", password: "synthetic sufficiently long password" });
identity.assignRole(operator.principal_id, "operator", owner.principal_id);
const registry = getCanonicalRegistry();
const descriptors = Object.fromEntries(["sync_identity", "sync_export", "sync_import", "sync_diff"].map(name => [name, registry.get(name)]));

test.after(() => {
  db.closeDatabase();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("sync tools use the same dedicated permissions as Dashboard sync routes", () => {
  assert.equal(dispatcher.requiredToolPermission(descriptors.sync_identity, { action: "get" }), "sync.read");
  assert.equal(dispatcher.requiredToolPermission(descriptors.sync_export, {}), "sync.read");
  assert.equal(dispatcher.requiredToolPermission(descriptors.sync_export, { project: "synthetic-project" }), "memory.read");
  assert.equal(dispatcher.requiredToolPermission(descriptors.sync_diff, { since: "2026-01-01T00:00:00.000Z" }), "sync.read");
  assert.equal(dispatcher.requiredToolPermission(descriptors.sync_diff, { project: "synthetic-project", since: "2026-01-01T00:00:00.000Z" }), "memory.read");
  assert.equal(dispatcher.requiredToolPermission(descriptors.sync_identity, { action: "set_user" }), "sync.manage");
  assert.equal(dispatcher.requiredToolPermission(descriptors.sync_import, {}), "sync.manage");
  assert.equal(dispatcher.requiredToolPermission(descriptors.sync_import, { project: "synthetic-project" }), "memory.write");
});

test("operator generic tool access cannot inspect, export, import, or change sync identity", async () => {
  const initialUserId = db.getUserId();
  const initialMemoryCount = db.getDb().prepare("SELECT COUNT(*) AS count FROM memories").get().count;
  const context = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" } };
  const requests = [
    [descriptors.sync_identity, { action: "get" }],
    [descriptors.sync_identity, { action: "set_user", user_id: "synthetic-forged-sync-user" }],
    [descriptors.sync_export, {}],
    [descriptors.sync_diff, { since: "2026-01-01T00:00:00.000Z" }],
    [descriptors.sync_import, { data: JSON.stringify({ memories: [{ type: "fact", content: "synthetic unauthorized import" }] }) }],
  ];
  for (const [descriptor, args] of requests) {
    const result = await dispatcher.dispatchTestTool({ descriptor, args, context });
    assert.equal(result.isError, true, `${descriptor.name} ${args.action || ""} must be denied`);
    assert.equal(result.code, "authorization_denied");
  }
  assert.equal(db.getUserId(), initialUserId, "denied set_user must not mutate global sync identity");
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS count FROM memories").get().count, initialMemoryCount, "denied import must not write memory");
});

test("dedicated owner permissions preserve authorized sync operations", async () => {
  const context = { authIdentity: { principal_id: owner.principal_id, principal_type: "human" } };
  const read = await dispatcher.dispatchTestTool({ descriptor: descriptors.sync_identity, args: { action: "get" }, context });
  const update = await dispatcher.dispatchTestTool({ descriptor: descriptors.sync_identity, args: { action: "set_user", user_id: "synthetic-authorized-sync-user" }, context });
  assert.notEqual(read.isError, true);
  assert.notEqual(update.isError, true);
  assert.equal(db.getUserId(), "synthetic-authorized-sync-user");
});
