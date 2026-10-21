"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-source-auth-"));
const workspace = path.join(root, "workspace");
const dataDir = path.join(root, "data");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_SECRET_KEY = "synthetic-source-auth-test-secret";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const kernel = require("../src/platform/kernel");
const projectAccess = require("../src/core/project-access");
const bundled = require("../src/packs/bundled");
const packLifecycle = require("../src/packs/lifecycle");
const { callInternalTool } = require("../src/tools/dispatcher");

const owner = identity.bootstrapOwner({ username: `source-auth-owner-${process.pid}`, password: "synthetic-source-owner-pass" });
const project = `source_auth_${process.pid}`;
kernel.registerProject({ project_id: project, owner_actor_id: owner.principal_id, source: "test" });
const campaign = kernel.createResearchCampaign({ project_id: project, name: "Source access fixture", created_by: owner.principal_id });
bundled.installBundledPack("security-research", { enable: true, config: { workspace } });
const packHealth = packLifecycle.health("security-research");
if (packHealth.status !== "healthy") throw new Error(`security-research test pack did not activate: ${JSON.stringify(packHealth)}`);

const outsider = identity.createPrincipal({ type: "service", displayName: "Source test restricted principal" });
identity.assignRole(outsider.principal_id, "administrator", owner.principal_id);
const limitedContext = {
  source: "internal",
  authIdentity: { principal_id: outsider.principal_id, principal_type: "service", scopes: ["tools.execute_high"] },
};
const staging = path.join(workspace, "projects", campaign.campaign_id, "repositories", "fixture_repo", ".source_snap_scope.staging");
fs.mkdirSync(staging, { recursive: true });
const marker = path.join(staging, "preserve-before-write-grant.txt");
fs.writeFileSync(marker, "synthetic fixture");

test("research_source enforces principal, project, and read/write grants at the dispatcher boundary", async () => {
  const deniedRead = await callInternalTool("research_source", { action: "list", project_id: project }, limitedContext);
  assert.equal(deniedRead.isError, true);
  assert.equal(deniedRead.code, "not_found");
  assert.equal(fs.existsSync(marker), true);

  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: outsider.principal_id, project, accessLevel: "read" });
  const allowedRead = await callInternalTool("research_source", { action: "list", project_id: project }, limitedContext);
  assert.notEqual(allowedRead.isError, true, "a project reader can list within the granted project");

  const deniedWrite = await callInternalTool("research_source", { action: "recover", campaign_id: campaign.campaign_id, project_id: project, confirm: true }, limitedContext);
  assert.equal(deniedWrite.isError, true, "read access alone cannot run recovery");
  assert.equal(fs.existsSync(marker), true, "denied recovery must leave staging data unchanged");

  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: outsider.principal_id, project, accessLevel: "write" });
  const allowedWrite = await callInternalTool("research_source", { action: "recover", campaign_id: campaign.campaign_id, project_id: project, confirm: true }, limitedContext);
  assert.notEqual(allowedWrite.isError, true, "write access permits the intended recovery operation");
  assert.equal(fs.existsSync(marker), false, "authorized recovery removes the abandoned fixture staging directory");
});

after(() => {
  try { db.closeDatabase(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});
