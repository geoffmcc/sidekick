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
const { validateLocalArguments, createDeveloperServices, boundedResult, effectiveConcurrency, effectiveOutputLimit } = require("../src/node/agent");
const { createWorkspace } = require("../src/node/workspace");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");
const developerEntry = require("../packs/developer/modules/developer-tools/entry");

const owner = identity.bootstrapOwner({ username: "node_admin_test_owner", password: "synthetic test password with sufficient length" });
const ownerContext = { principal_id: owner.principal_id };
const ownerCredential = authentication.createCredential({
  principalId: owner.principal_id,
  displayName: "synthetic execution-node admin credential",
  scopes: ["compute.nodes.read", "compute.nodes.manage", "compute.jobs.cancel"],
  createdByPrincipalId: owner.principal_id,
  actorContext: ownerContext,
});
const operator = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "execution-node admin test operator", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
identity.assignRole(operator.principal_id, "operator", owner);
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

test("execution-node admin failures hide exception details and use server-error status", async () => {
  const originalAuthorizeWorkspace = executionNode.authorizeWorkspace;
  const originalRevokeWorker = compute.workerManager.revokeWorker;
  const originalRequestCancel = executionNode.requestCancel;
  const secretDiagnostic = "synthetic-secret /srv/sidekick/private/db.sqlite";
  try {
    executionNode.authorizeWorkspace = () => { throw new Error(secretDiagnostic); };
    compute.workerManager.revokeWorker = () => { throw new Error(secretDiagnostic); };
    executionNode.requestCancel = () => { throw new Error(secretDiagnostic); };

    const cases = [
      ["/nodes/wk_admin_test/workspaces", { name: "dev", rootIdentity: "root-hash" }, "Execution-node workspace authorization failed"],
      ["/nodes/wk_admin_test/revoke", { reason: "test" }, "Execution-node node revocation failed"],
      ["/jobs/job_admin_test/cancel", {}, "Execution-node job cancellation failed"],
    ];
    for (const [route, body, message] of cases) {
      const response = await request(route, { token: ownerCredential.token, method: "POST", body });
      assert.equal(response.status, 500);
      const result = await response.json();
      assert.deepEqual(result, { ok: false, error: message, code: "execution_node_admin_failed" });
      assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|private|db\.sqlite/);
    }
  } finally {
    executionNode.authorizeWorkspace = originalAuthorizeWorkspace;
    compute.workerManager.revokeWorker = originalRevokeWorker;
    executionNode.requestCancel = originalRequestCancel;
  }
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

test("execution node enforces its local workspace write grant for file writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-node-local-write-"));
  const target = path.join(root, "output.txt");
  const write = getCanonicalRegistry({ includeActiveModules: false }).get("write");
  assert.ok(write, "canonical write descriptor is available");
  const readOnlyWorkspace = createWorkspace({ name: "read-only", root, permissions: { read: true, write: false } });
  assert.throws(
    () => validateLocalArguments(write, { path: target, content: "synthetic" }, readOnlyWorkspace),
    /does not permit write/,
    "local read permission cannot be treated as permission to write"
  );
  const writableWorkspace = createWorkspace({ name: "writable", root, permissions: { read: true, write: true } });
  assert.deepEqual(validateLocalArguments(write, { path: target, content: "synthetic" }, writableWorkspace), { path: target, content: "synthetic" });
  assert.throws(
    () => validateLocalArguments(write, { path: path.join(os.tmpdir(), "outside-node-workspace.txt"), content: "synthetic" }, writableWorkspace),
    /outside the authorized workspace/,
    "write permission remains bounded to the configured workspace"
  );
});

test("execution node applies workspace concurrency and output limits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-node-local-limits-"));
  const limitedWorkspace = createWorkspace({ name: "bounded", root, limits: { maxConcurrent: 1, maxOutputBytes: 2048 } });
  assert.equal(effectiveConcurrency(limitedWorkspace), 1, "node claims are bounded by the smaller workspace concurrency grant");
  assert.equal(effectiveOutputLimit(limitedWorkspace), 2048, "result bounds reflect the workspace output grant");
  const result = boundedResult({ content: [{ type: "text", text: "x".repeat(4096) }] }, effectiveOutputLimit(limitedWorkspace));
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 2048, "normalized worker output remains within the configured byte limit");
  assert.equal(result.truncated, true);
});

test("node-safe tools bind implicit paths to the authorized workspace root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-node-path-defaults-"));
  const readWriteWorkspace = createWorkspace({ name: "bounded-defaults", root, permissions: { read: true, write: true } });
  const registry = getCanonicalRegistry({ includeActiveModules: false });
  const cases = [
    ["list", {}],
    ["search", { pattern: "synthetic" }],
    ["security_scan", {}],
    ["git", { action: "status" }],
    ["changelog", { action: "preview", from: "v1.0.0" }],
  ];
  for (const [name, args] of cases) {
    const descriptor = registry.get(name);
    assert.ok(descriptor, `canonical ${name} descriptor is available`);
    assert.equal(validateLocalArguments(descriptor, args, readWriteWorkspace).path, root, `${name} defaults stay in the workspace`);
  }
  const developerDescriptors = developerEntry.buildDescriptors({
    config: { repository_roots: [root] },
    paths: { enforce: () => null },
    dispatch: async () => ({ content: [] }),
  });
  for (const name of ["semantic_repo", "dev_repo_profile", "dev_change_summary", "dev_verify"]) {
    const descriptor = developerDescriptors.find(item => item.name === name);
    assert.ok(descriptor, `developer ${name} descriptor is available`);
    assert.equal(validateLocalArguments(descriptor, {}, readWriteWorkspace).path, root, `${name} defaults stay in the workspace`);
  }
});

test("execution-node Developer service keeps nested tool calls behind workspace grants and canonical dispatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-node-developer-dispatch-"));
  const command = { command: "npm test", cwd: root };
  const options = { timeoutMs: 12345 };
  const bash = getCanonicalRegistry({ includeActiveModules: false }).get("bash");
  assert.ok(bash, "canonical bash descriptor is available");

  const readOnlyWorkspace = createWorkspace({ name: "developer-read-only", root, permissions: { read: true, write: false, execute: false } });
  let calls = 0;
  const deniedServices = createDeveloperServices(getCanonicalRegistry({ includeActiveModules: false }), {
    targetWorkspace: readOnlyWorkspace,
    dispatchCanonical: async () => { calls += 1; return { content: [] }; },
  });
  const denied = await deniedServices.dispatch("bash", command, options);
  assert.equal(denied.isError, true);
  assert.equal(denied.code, "workspace_denied");
  assert.match(denied.content[0].text, /execution is not granted/);
  assert.equal(calls, 0, "a missing local execution grant blocks dispatch before the canonical tool layer");

  const executableWorkspace = createWorkspace({ name: "developer-executable", root, permissions: { read: true, write: false, execute: true } });
  let dispatched;
  const allowedServices = createDeveloperServices(getCanonicalRegistry({ includeActiveModules: false }), {
    targetWorkspace: executableWorkspace,
    dispatchCanonical: async (...args) => { dispatched = args; return { content: [{ type: "text", text: "synthetic result" }] }; },
  });
  const allowed = await allowedServices.dispatch("bash", command, options);
  assert.equal(allowed.content[0].text, "synthetic result");
  assert.deepEqual(dispatched, ["bash", command, options], "nested tool execution returns to canonical policy with original arguments and limits");

  const outsideServices = createDeveloperServices(getCanonicalRegistry({ includeActiveModules: false }), {
    targetWorkspace: executableWorkspace,
    dispatchCanonical: async () => { calls += 1; return { content: [] }; },
  });
  const outside = await outsideServices.dispatch("bash", { command: "npm test", cwd: path.join(root, "..", "outside") }, options);
  assert.equal(outside.isError, true);
  assert.equal(outside.code, "workspace_denied");
  assert.equal(calls, 0, "a path outside the node grant never reaches canonical dispatch");

  const unknown = await allowedServices.dispatch("not_a_tool", {});
  assert.equal(unknown.isError, true);
  assert.equal(dispatched.length, 3, "unknown tools never reach canonical dispatch");
  assert.equal(typeof bash.handler, "function");

  const defaultServices = createDeveloperServices(getCanonicalRegistry({ includeActiveModules: false }), { targetWorkspace: executableWorkspace });
  const unauthenticated = await defaultServices.dispatch("bash", command, options);
  assert.equal(unauthenticated.isError, true);
  assert.equal(unauthenticated.code, "unauthenticated", "the production adapter applies canonical identity policy before a command can execute");
});
