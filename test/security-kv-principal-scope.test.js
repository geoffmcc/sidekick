"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-kv-principal-scope-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete process.env.SIDEKICK_DB_FILE;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const dbStore = require("../src/db");
const { callMcpTool } = require("../src/tools");
const { createOwnerContext, createServiceContext } = require("./helpers/authorized-context");
const projectAccess = require("../src/core/project-access");
const toolContext = require("../src/tools/context");
const storage = require("../src/tools/families/storage");

test("KV principal namespaces isolate shared projects and legacy rows", async () => {
  dbStore.runPendingMigrations();
  const owner = createOwnerContext({ source: "test" });
  require("../src/platform/kernel").registerProject({
    project_id: "kv_scope_project", owner_actor_id: owner.authIdentity.principal_id, source: "test",
  });
  const first = createServiceContext({ role: "operator", source: "test" });
  const second = createServiceContext({ role: "operator", source: "test" });
  for (const principal of [first, second]) {
    projectAccess.grantProjectAccess({
      actorPrincipalId: owner.authIdentity.principal_id,
      principalId: principal.authIdentity.principal_id,
      project: "kv_scope_project",
      accessLevel: "write",
    });
  }

  const firstContext = { ...first, project: "kv_scope_project" };
  const secondContext = { ...second, project: "kv_scope_project" };
  const store = (context, value) => callMcpTool("store", { key: "same-key", value }, context);
  const get = context => callMcpTool("get", { key: "same-key" }, context);

  const firstWrite = await store(firstContext, "first principal value");
  const secondWrite = await store(secondContext, "second principal value");
  assert.equal(firstWrite.isError, undefined);
  assert.equal(secondWrite.isError, undefined);
  assert.equal(getText(await get(firstContext)), "first principal value");
  assert.equal(getText(await get(secondContext)), "second principal value");

  dbStore.setKV("legacy_unowned_key", "legacy value", null, "legacy-import", "test");
  const legacyRead = await callMcpTool("get", { key: "legacy_unowned_key" }, firstContext);
  assert.equal(legacyRead.isError, true);
  assert.match(legacyRead.content[0].text, /Key not found/);

  const direct = await toolContext.runWithContext(
    toolContext.createMcpExecutionContext(firstContext),
    () => storage.sidekick_store({ key: "direct-bypass", value: "must not write" }),
  );
  assert.equal(direct.code, "canonical_dispatch_required");
  assert.equal(dbStore.getKV("direct-bypass"), null);
});

function getText(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result.content[0].text;
}

test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
