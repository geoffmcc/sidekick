"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, `test-data-workspace-identity-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_SECRET_KEY = "workspace-identity-test-key";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_TOOL_POLICY = "open";

for (const modulePath of ["../src/tools", "../src/db", "../src/platform/kernel"]) {
  delete require.cache[require.resolve(modulePath)];
}

const tools = require("../src/tools");
const db = require("../src/db");
const { runWithContext } = require("../src/tools/context");
const { createOwnerContext, createServiceContext } = require("./helpers/authorized-context");

(async () => {
  try {
    const ownerContext = createOwnerContext({ source: "test", project: "workspace-identity" });
    const actorContext = createServiceContext({ role: "administrator", source: "test", project: "workspace-identity" });
    require("../src/core/project-access").grantProjectAccess({
      actorPrincipalId: ownerContext.authIdentity.principal_id,
      principalId: actorContext.authIdentity.principal_id,
      project: "workspace-identity",
      accessLevel: "write",
    });
    const context = { ...actorContext, authIdentity: { ...actorContext.authIdentity, acting_for_principal_id: ownerContext.authIdentity.principal_id } };
    const result = await runWithContext(context, () => tools.TOOLS.workspace({
      action: "create",
      project: "workspace-identity",
    }));
    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const workspace = JSON.parse(result.content[0].text);
    assert.strictEqual(workspace.owner_id, ownerContext.authIdentity.principal_id);

    const event = db.getDb().prepare("SELECT actor_id FROM platform_execution_events WHERE event_type = 'workspace.created' AND subject_id = ?").get(workspace.workspace_id);
    assert.strictEqual(event.actor_id, actorContext.authIdentity.principal_id);

    const secretResult = await runWithContext(context, () => tools.TOOLS.workspace({
      action: "set_secret",
      workspace_id: workspace.workspace_id,
      secret_name: "token",
      secret_value: "not-persisted-as-plaintext",
    }));
    assert.strictEqual(secretResult.isError, undefined, secretResult.content?.[0]?.text);
    const secretEvent = db.getDb().prepare("SELECT actor_id FROM platform_execution_events WHERE event_type = 'workspace.secret_set' AND subject_id = ?").get(workspace.workspace_id);
    assert.strictEqual(secretEvent.actor_id, actorContext.authIdentity.principal_id);
    console.log("Workspace identity wiring: 3 passed");
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
