"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-workspace-scope-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "synthetic-workspace-scope-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const platformKernel = require("../src/platform/kernel");
const projectAccess = require("../src/core/project-access");
const { callMcpTool } = require("../src/tools");
const { createOwnerContext } = require("./helpers/authorized-context");

test("workspace data and secret names are limited to authorized projects", async t => {
  t.after(() => {
    db.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const ownerContext = createOwnerContext({ source: "mcp" });
  const owner = identity.getPrincipal(ownerContext.authIdentity.principal_id);
  const allowedProject = "workspace_scope_allowed";
  const deniedProject = "workspace_scope_denied";
  platformKernel.registerProject({ project_id: allowedProject, owner_actor_id: owner.principal_id, source: "test" });
  platformKernel.registerProject({ project_id: deniedProject, owner_actor_id: owner.principal_id, source: "test" });
  const allowedWorkspace = platformKernel.createProjectWorkspace({ project_id: allowedProject, name: "Allowed" });
  const deniedWorkspace = platformKernel.createProjectWorkspace({ project_id: deniedProject, name: "Denied" });

  const peer = identity.createPrincipal({
    type: "service",
    displayName: "Workspace scoped peer",
    actorIdentity: owner,
  });
  for (const permission of ["tools.execute_high", "memory.read"]) {
    identity.grantPrincipalPermission(peer.principal_id, permission, owner);
  }
  projectAccess.grantProjectAccess({
    actorPrincipalId: owner.principal_id,
    principalId: peer.principal_id,
    project: allowedProject,
    accessLevel: "read",
  });

  const peerContext = {
    source: "mcp",
    authIdentity: { principal_id: peer.principal_id, principal_type: "service", scopes: null },
  };
  const call = (args, options = peerContext) => callMcpTool("workspace", args, options);

  const visible = await call({ action: "get", workspace_id: allowedWorkspace.workspace_id });
  assert.equal(visible.isError, undefined, visible.content?.[0]?.text);
  assert.equal(JSON.parse(visible.content[0].text).workspace_id, allowedWorkspace.workspace_id);

  const hidden = await call({ action: "get", workspace_id: deniedWorkspace.workspace_id });
  assert.equal(hidden.isError, true);
  assert.equal(hidden.content[0].text, "Workspace not found");
  const hiddenWithBoundProject = await call({ action: "get", workspace_id: deniedWorkspace.workspace_id }, {
    ...peerContext,
    project: allowedProject,
  });
  assert.equal(hiddenWithBoundProject.isError, true);
  assert.equal(hiddenWithBoundProject.content[0].text, "Workspace not found");

  const filtered = await call({ action: "list" });
  const filteredRows = JSON.parse(filtered.content[0].text).workspaces;
  assert.ok(filteredRows.some(row => row.workspace_id === allowedWorkspace.workspace_id));
  assert.ok(!filteredRows.some(row => row.workspace_id === deniedWorkspace.workspace_id));

  const deniedList = await call({ action: "list", project: deniedProject });
  assert.equal(deniedList.isError, true);
  assert.match(deniedList.content[0].text, /workspace_access_denied/);

  const deniedWrite = await call({ action: "create", project: allowedProject, name: "Read only cannot create" });
  assert.equal(deniedWrite.isError, true);
  assert.match(deniedWrite.content[0].text, /workspace_access_denied/);

  for (const args of [
    { action: "update", workspace_id: allowedWorkspace.workspace_id, config: { altered: true } },
    { action: "set_secret", workspace_id: deniedWorkspace.workspace_id, secret_name: "token", secret_value: "synthetic-value" },
    { action: "delete_secret", workspace_id: deniedWorkspace.workspace_id, secret_name: "token" },
  ]) {
    const deniedMutation = await call(args);
    assert.equal(deniedMutation.isError, true);
    assert.equal(deniedMutation.content[0].text, "Workspace not found");
  }

  const deniedBackfill = await call({ action: "backfill_secrets" });
  assert.equal(deniedBackfill.isError, true);
  assert.match(deniedBackfill.content[0].text, /workspace_global_access_denied/);

});
