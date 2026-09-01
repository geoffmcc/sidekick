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
const { createTestExecutionContext, runWithContext } = require("../src/tools/context");

(async () => {
  try {
    const context = createTestExecutionContext({
      project: "workspace-identity",
      authIdentity: {
        principal_id: "prn_workspace_actor",
        acting_for_principal_id: "prn_workspace_owner",
      },
    });
    const result = await runWithContext(context, () => tools.TOOLS.workspace({
      action: "create",
      project: "workspace-identity",
    }));
    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const workspace = JSON.parse(result.content[0].text);
    assert.strictEqual(workspace.owner_id, "prn_workspace_owner");

    const event = db.getDb().prepare("SELECT actor_id FROM platform_execution_events WHERE event_type = 'workspace.created' AND subject_id = ?").get(workspace.workspace_id);
    assert.strictEqual(event.actor_id, "prn_workspace_actor");

    const secretResult = await runWithContext(context, () => tools.TOOLS.workspace({
      action: "set_secret",
      workspace_id: workspace.workspace_id,
      secret_name: "token",
      secret_value: "not-persisted-as-plaintext",
    }));
    assert.strictEqual(secretResult.isError, undefined, secretResult.content?.[0]?.text);
    const secretEvent = db.getDb().prepare("SELECT actor_id FROM platform_execution_events WHERE event_type = 'workspace.secret_set' AND subject_id = ?").get(workspace.workspace_id);
    assert.strictEqual(secretEvent.actor_id, "prn_workspace_actor");
    console.log("Workspace identity wiring: 3 passed");
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
