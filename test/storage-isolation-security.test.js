"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-storage-isolation-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
const storage = require("../src/tools/families/storage");
const db = require("../src/db");
const identity = require("../src/core/identity");
const projectAccess = require("../src/core/project-access");
const platformKernel = require("../src/platform/kernel");
const tools = require("../src/tools");

db.runPendingMigrations();
const owner = identity.bootstrapOwner({ username: "storage_isolation_owner", password: "a sufficiently long storage password" });
const principalA = identity.createHumanUser({ username: "storage_isolation_a", password: "a sufficiently long principal password" });
const principalB = identity.createHumanUser({ username: "storage_isolation_b", password: "another sufficiently long password" });
identity.assignRole(principalA.principal_id, "operator", owner.principal_id);
identity.assignRole(principalB.principal_id, "operator", owner.principal_id);
platformKernel.registerProject({ project_id: "alpha", owner_actor_id: principalA.principal_id, source: "test" });
platformKernel.registerProject({ project_id: "beta", owner_actor_id: owner.principal_id, source: "test" });

async function asPrincipal(principalId, project, tool, args) {
  return tools.dispatchTool({ name: tool, args, context: {
    source: "mcp", project,
    authIdentity: { principal_id: principalId, principal_type: "human", scopes: null },
  } });
}

async function main() {
  db.setKV("dashboard_test:remove:1", "one", "system", "test");
  db.setKV("dashboard_test:remove:2", "two", "system", "test");
  db.setKV("dashboard_test:removeX:keep", "keep", "system", "test");
  const countBeforePrefixDelete = db.countKV();
  assert.ok(countBeforePrefixDelete >= 3, "KV count should use a direct aggregate query");
  assert.strictEqual(db.deleteKVByPrefix("dashboard_test:remove:"), 2, "prefix deletion must be bounded to the exact key range");
  assert.strictEqual(db.getKV("dashboard_test:removeX:keep").value, "keep", "prefix deletion must not affect neighboring keys");

  const key = `isolation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const directWrite = await storage.sidekick_store({ key, value: "must-not-persist", project: "alpha" });
  assert.equal(directWrite.code, "canonical_dispatch_required", "direct storage handler invocation must fail closed");
  assert.equal(db.getKV(key), null, "direct handler refusal must precede persistence");
  await asPrincipal(principalA.principal_id, "alpha", "store", { key, value: "alpha-secret", project: "alpha" });

  const crossUser = await asPrincipal(principalB.principal_id, "alpha", "get", { key });
  assert.strictEqual(crossUser.isError, true, "another principal must not read a known KV key");

  const sameUser = await asPrincipal(principalA.principal_id, "alpha", "get", { key });
  assert.match(sameUser.content[0].text, /alpha-secret/, "the owner must retain legitimate access");

  const principalPrefix = `__sidekick_principal_v1:${encodeURIComponent(principalA.principal_id)}:alpha:`;
  for (let index = 0; index < 1002; index++) {
    db.setKV(`${principalPrefix}bounded_${index}`, { value: `v${index}`, project: "alpha" }, "alpha", "test");
  }
  const bounded = await asPrincipal(principalA.principal_id, "alpha", "get_by_project", { project: "alpha" });
  assert.strictEqual(JSON.parse(bounded.content[0].text).length, 1000, "project reads must cap result rows");
  const scopedPage = db.listScopedKV({ project: "alpha", keyPrefix: principalPrefix, limit: 10 });
  assert.strictEqual(scopedPage.entries.length, 10);
  assert.strictEqual(scopedPage.truncated, true, "database scoped query must report capped pages");

  const oversizedKey = `${principalPrefix}legacy_oversized`;
  db.getDb().prepare("INSERT INTO kv_store(key, value_json, project, source) VALUES(?, ?, ?, ?)")
    .run(oversizedKey, JSON.stringify({ value: "x".repeat(3 * 1024 * 1024), project: "alpha" }), "alpha", "legacy-test");
  assert.throws(() => db.getKV(oversizedKey), error => error.code === "KV_VALUE_TOO_LARGE");
  const oversizedPage = db.listScopedKV({ project: "alpha", keyPrefix: principalPrefix, limit: 10 });
  assert.strictEqual(oversizedPage.oversized, 1, "legacy oversized rows must be detected without parsing their value");
  const withheld = await asPrincipal(principalA.principal_id, "alpha", "get_by_project", { project: "alpha" });
  assert.strictEqual(withheld.code, "kv_value_too_large", "project reads must fail closed when oversized legacy data exists");
  const oversizedWrite = await asPrincipal(principalA.principal_id, "alpha", "store", { key: "too_large", value: "x".repeat(3 * 1024 * 1024), project: "alpha" });
  assert.strictEqual(oversizedWrite.code, "KV_VALUE_TOO_LARGE", "new KV writes must enforce the storage value limit");

  const otherProject = await asPrincipal(principalA.principal_id, "beta", "get", { key, project: "alpha" });
  assert.strictEqual(otherProject.isError, true, "a project-scoped key must not cross project context");

  await asPrincipal(principalA.principal_id, "alpha", "delete", { key });
  console.log("storage isolation security tests passed");
  db.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
