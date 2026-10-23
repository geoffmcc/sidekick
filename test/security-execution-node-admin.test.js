"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-node-admin-security-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");
const express = require("express");
const { registerExecutionNodeAdminRoutes } = require("../src/node/admin-api");
const { validateLocalArguments } = require("../src/node/agent");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");

const owner = identity.bootstrapOwner({ username: "node_admin_test_owner", password: "synthetic test password with sufficient length" });
const ownerContext = { principal_id: owner.principal_id };
const ownerCredential = authentication.createCredential({
  principalId: owner.principal_id,
  displayName: "synthetic execution-node admin credential",
  scopes: ["compute.nodes.read", "compute.nodes.manage", "compute.jobs.cancel"],
  createdByPrincipalId: owner.principal_id,
  actorContext: ownerContext,
});
const operator = identity.createPrincipal({ type: "service", displayName: "execution-node admin test operator", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
identity.assignRole(operator.principal_id, "operator", owner.principal_id);
const operatorCredential = authentication.createCredential({
  principalId: operator.principal_id,
  displayName: "synthetic underprivileged credential",
  scopes: ["compute.nodes.manage"],
  createdByPrincipalId: owner.principal_id,
  actorContext: ownerContext,
});

const executionNode = {
  list: () => [{ workerId: "wk_admin_test" }],
  authorizeWorkspace: (workerId, workspace) => ({ ...workspace, workerId }),
  requestCancel: jobId => jobId === "job_admin_test" ? { jobId, workerId: "wk_admin_test", state: "leased" } : null,
};
const compute = { workerManager: { revokeWorker: workerId => workerId === "wk_admin_test" ? { workerId, state: "revoked" } : null } };
const app = express();
registerExecutionNodeAdminRoutes({ app, express, authentication, authorization, identity, dbStore, executionNode, compute });

let server;
let baseUrl;
after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(route, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("execution-node admin HTTP mutations require scoped permissions and record the initiating principal", async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}/execution-node/admin`;

  const deniedNoIdentity = await request("/nodes/wk_admin_test/workspaces", { method: "POST", body: { name: "dev", rootIdentity: "root-hash" } });
  assert.equal(deniedNoIdentity.status, 401);
  const deniedLegacyKey = await request("/nodes/wk_admin_test/workspaces", { token: "installation-wide-api-key-placeholder", method: "POST", body: { name: "dev", rootIdentity: "root-hash" } });
  assert.equal(deniedLegacyKey.status, 401, "the legacy installation key does not authorize this administrative API");
  const deniedOperator = await request("/nodes/wk_admin_test/workspaces", { token: operatorCredential.token, method: "POST", body: { name: "dev", rootIdentity: "root-hash" } });
  assert.equal(deniedOperator.status, 403);

  const workspaceResponse = await request("/nodes/wk_admin_test/workspaces", {
    token: ownerCredential.token,
    method: "POST",
    body: { name: "dev", rootIdentity: "root-hash", permissions: { read: true, write: false } },
  });
  assert.equal(workspaceResponse.status, 200, await workspaceResponse.clone().text());
  const workspaceAudit = dbStore.getDb().prepare("SELECT actor_principal_id, event_type FROM identity_audit_events WHERE event_type = 'execution_node.workspace.authorized' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(workspaceAudit.actor_principal_id, owner.principal_id);

  const cancelResponse = await request("/jobs/job_admin_test/cancel", { token: ownerCredential.token, method: "POST", body: {} });
  assert.equal(cancelResponse.status, 200);
  const cancelAudit = dbStore.getDb().prepare("SELECT actor_principal_id, event_type FROM identity_audit_events WHERE event_type = 'execution_node.job.cancel_requested' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(cancelAudit.actor_principal_id, owner.principal_id);

  const revokeResponse = await request("/nodes/wk_admin_test/revoke", { token: ownerCredential.token, method: "POST", body: { reason: "synthetic test" } });
  assert.equal(revokeResponse.status, 200);
  const revokeAudit = dbStore.getDb().prepare("SELECT actor_principal_id, event_type FROM identity_audit_events WHERE event_type = 'execution_node.revoked' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(revokeAudit.actor_principal_id, owner.principal_id);
});

test("execution node refuses network Git actions even when a scope name is configured", () => {
  const previousScope = process.env.SIDEKICK_NODE_NETWORK_SCOPE;
  process.env.SIDEKICK_NODE_NETWORK_SCOPE = "synthetic-git-scope";
  try {
    const git = getCanonicalRegistry({ includeActiveModules: false }).get("git");
    assert.ok(git, "canonical Git descriptor is available");
    for (const action of ["pull", "push"]) {
      assert.throws(
        () => validateLocalArguments(git, { action, path: path.join(os.tmpdir(), "synthetic-repository") }),
        /no enforced scoped egress broker/,
        `${action} must fail closed instead of treating a scope label as enforcement`
      );
    }
  } finally {
    if (previousScope === undefined) delete process.env.SIDEKICK_NODE_NETWORK_SCOPE;
    else process.env.SIDEKICK_NODE_NETWORK_SCOPE = previousScope;
  }
});
