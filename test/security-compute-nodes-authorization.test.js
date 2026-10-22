"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-compute-nodes-auth-"));
process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const dispatcher = require("../src/tools/dispatcher");
const compute = require("../src/compute");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");

const owner = identity.bootstrapOwner({ username: "compute_nodes_security_owner", password: "synthetic sufficiently long password" });
const operator = identity.createHumanUser({ username: "compute_nodes_security_operator", password: "synthetic sufficiently long password" });
identity.assignRole(operator.principal_id, "operator", owner.principal_id);
const descriptor = getCanonicalRegistry().get("compute_nodes");
compute.initialize();

test.after(() => {
  db.closeDatabase();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("Compute node actions require their matching read or manage permission", () => {
  for (const action of ["list", "get", "telemetry", "stats", "list_tokens"]) {
    assert.equal(dispatcher.requiredToolPermission(descriptor, { action }), "compute.nodes.read", `${action} is a governed read`);
  }
  for (const action of ["heartbeat", "revoke", "maintenance", "create_token", "enroll"]) {
    assert.equal(dispatcher.requiredToolPermission(descriptor, { action }), "compute.nodes.manage", `${action} is a governed mutation`);
  }
});

test("operator cannot list worker metadata or mint enrollment tokens through MCP", async () => {
  const before = db.getDb().prepare("SELECT COUNT(*) AS count FROM compute_enrollment_tokens").get().count;
  const context = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" } };
  const read = await dispatcher.dispatchTestTool({ descriptor, args: { action: "list" }, context });
  const create = await dispatcher.dispatchTestTool({ descriptor, args: { action: "create_token", display_name: "denied synthetic token" }, context });
  assert.equal(read.isError, true);
  assert.equal(read.code, "authorization_denied");
  assert.equal(create.isError, true);
  assert.equal(create.code, "authorization_denied");
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS count FROM compute_enrollment_tokens").get().count, before, "denied calls have no token-creation effect");
});

test("enrollment token creator attribution comes from the authenticated principal", async () => {
  const result = await dispatcher.dispatchTestTool({
    descriptor,
    args: { action: "create_token", display_name: "synthetic attributed token", created_by: "forged-creator" },
    context: { authIdentity: { principal_id: owner.principal_id, principal_type: "human" } },
  });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  const row = db.getDb().prepare("SELECT created_by FROM compute_enrollment_tokens WHERE token_id = ?").get(payload.tokenId);
  assert.equal(row.created_by, owner.principal_id);
  assert.equal(row.created_by === "forged-creator", false);
});

test("worker enrollment credential is shown only through the authenticated one-time result", async () => {
  const token = compute.workerManager.createEnrollmentToken({ displayName: "synthetic enrolled worker", createdBy: owner.principal_id });
  const result = await dispatcher.dispatchTestTool({
    descriptor,
    args: { action: "enroll", token: token.token, node_id: "synthetic-compute-node", display_name: "Synthetic worker", platform: "linux" },
    context: { authIdentity: { principal_id: owner.principal_id, principal_type: "human" } },
  });
  assert.equal(result.isError, undefined);
  assert.equal("credential" in result, false, "sensitive result must not create a reusable structured credential field");
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.workerId.startsWith("wk_"), true);
  assert.match(payload.credential, /^wksec_/);
  assert.equal(payload.credentialType, "worker-bearer-v1");
  const logEntries = db.getDb().prepare("SELECT entry_json FROM tool_logs WHERE tool_name='compute_nodes' ORDER BY id DESC LIMIT 2").all();
  assert.ok(logEntries.length > 0);
  assert.equal(logEntries.some((row) => row.entry_json.includes(payload.credential)), false, "one-time credential is not written to tool logs");
});

test("unauthenticated callers cannot mint enrollment tokens", async () => {
  const before = db.getDb().prepare("SELECT COUNT(*) AS count FROM compute_enrollment_tokens").get().count;
  const result = await dispatcher.dispatchTestTool({ descriptor, args: { action: "create_token", display_name: "unauthenticated synthetic token" } });
  assert.equal(result.isError, true);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS count FROM compute_enrollment_tokens").get().count, before);
});
