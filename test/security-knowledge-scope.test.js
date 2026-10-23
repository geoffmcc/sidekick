"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-knowledge-scope-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete process.env.SIDEKICK_DB_FILE;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const dbStore = require("../src/db");
const { callMcpTool } = require("../src/tools");
const { createOwnerContext, createServiceContext } = require("./helpers/authorized-context");
const projectAccess = require("../src/core/project-access");
const { createContextEngine } = require("../src/context/engine");

test("knowledge reads and writes respect project membership across tools and agent retrieval", async () => {
  dbStore.runPendingMigrations();
  const owner = createOwnerContext({ source: "test" });
  for (const project_id of ["knowledge_alpha", "knowledge_beta"]) {
    require("../src/platform/kernel").registerProject({
      project_id, owner_actor_id: owner.authIdentity.principal_id, source: "test",
    });
  }
  const alpha = createServiceContext({ role: "operator", source: "test" });
  const beta = createServiceContext({ role: "operator", source: "test" });
  const outsider = createServiceContext({ role: "operator", source: "test" });
  for (const [principalId, project] of [
    [alpha.authIdentity.principal_id, "knowledge_alpha"],
    [beta.authIdentity.principal_id, "knowledge_beta"],
  ]) {
    projectAccess.grantProjectAccess({
      actorPrincipalId: owner.authIdentity.principal_id,
      principalId,
      project,
      accessLevel: "write",
    });
  }

  async function add(context, title) {
    const result = await callMcpTool("knowledge", {
      action: "add", category: "scope-test", title, content: `Synthetic ${title} content`,
    }, context);
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return Number(result.content[0].text.match(/id: (\d+)/)?.[1]);
  }
  const globalId = await add(owner, "Global knowledge scope canary");
  const alphaId = await add({ ...alpha, project: "knowledge_alpha" }, "Alpha knowledge scope canary");
  const betaId = await add({ ...beta, project: "knowledge_beta" }, "Beta knowledge scope canary");

  async function search(context) {
    return callMcpTool("knowledge", { action: "search", query: "knowledge scope canary", category: "scope-test" }, context);
  }
  const alphaSearch = await search({ ...alpha, project: "knowledge_alpha" });
  const alphaTitles = JSON.parse(alphaSearch.content[0].text).map(row => row.title);
  assert.ok(alphaTitles.includes("Global knowledge scope canary"));
  assert.ok(alphaTitles.includes("Alpha knowledge scope canary"));
  assert.ok(!alphaTitles.includes("Beta knowledge scope canary"));

  const unscopedSearch = await search(alpha);
  const unscopedTitles = JSON.parse(unscopedSearch.content[0].text).map(row => row.title);
  assert.deepEqual(unscopedTitles, ["Global knowledge scope canary"]);

  const denied = await search({ ...outsider, project: "knowledge_alpha" });
  assert.equal(denied.isError, true);
  assert.equal(denied.code, "forbidden");

  const crossProjectGet = await callMcpTool("knowledge", { action: "get", id: alphaId }, { ...beta, project: "knowledge_beta" });
  assert.equal(crossProjectGet.isError, true);
  assert.match(crossProjectGet.content[0].text, /not found/);
  const crossProjectUpdate = await callMcpTool("knowledge", {
    action: "update", id: alphaId, content: "unauthorized overwrite",
  }, { ...beta, project: "knowledge_beta" });
  assert.equal(crossProjectUpdate.isError, true);
  assert.equal(dbStore.getDb().prepare("SELECT content FROM knowledge WHERE id = ?").get(alphaId).content, "Synthetic Alpha knowledge scope canary content");

  const engine = createContextEngine({ dbStore });
  const manifest = await engine.assemble({ query: "knowledge scope canary", project: "knowledge_alpha", principalId: alpha.authIdentity.principal_id });
  const contextTitles = manifest.entries.filter(entry => entry.source === "knowledge").map(entry => entry.summary);
  assert.ok(contextTitles.includes("Global knowledge scope canary"));
  assert.ok(contextTitles.includes("Alpha knowledge scope canary"));
  assert.ok(!contextTitles.includes("Beta knowledge scope canary"));

  let dashboardHandler;
  require("../src/dashboard/knowledge-route").registerKnowledgeRoute({
    app: { get(route, handler) { if (route === "/api/knowledge") dashboardHandler = handler; } },
    dbStore,
    requireIdentityPermission: () => true,
    errorResponse: (_req, res) => res.status(500).json({ ok: false }),
  });
  let dashboardBody;
  dashboardHandler(
    { query: { limit: "50" }, authPrincipal: alpha.authIdentity },
    { json(body) { dashboardBody = body; }, status() { return this; } },
  );
  const dashboardTitles = dashboardBody.knowledge.map(row => row.title);
  assert.ok(dashboardTitles.includes("Global knowledge scope canary"));
  assert.ok(dashboardTitles.includes("Alpha knowledge scope canary"));
  assert.ok(!dashboardTitles.includes("Beta knowledge scope canary"));

  assert.ok(globalId > 0 && betaId > 0);
});

test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
