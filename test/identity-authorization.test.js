const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, `test-data-identity-authorization-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authorization = require("../src/core/authorization");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

try {
  test("migration registers permission catalog and role bundles", () => {
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_permissions WHERE permission = 'users.manage'").get());
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'operator' AND permission = 'workflows.execute'").get());
  });

  const owner = identity.bootstrapOwner({ username: "owner", password: "correct horse battery staple", displayName: "Owner" });
  const operator = identity.createHumanUser({ username: "operator", password: "another correct password", displayName: "Operator" });
  identity.assignRole(operator.principal_id, "operator", owner.principal_id);
  const agent = identity.createPrincipal({ type: "agent", displayName: "Build Agent", actorPrincipalId: owner.principal_id });

  test("authorization evaluates permissions rather than role names", () => {
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_permissions WHERE permission = 'blackbox.read'").get());
    assert.strictEqual(authorization.authorize({ principalId: owner.principal_id, permission: "blackbox.read" }).ok, true);
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "blackbox.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute" }).ok, true);
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "users.manage" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "not.registered" }).code, "unknown-permission");
    assert.strictEqual(authorization.authorize({ principalId: null, permission: "workflows.execute" }).code, "unauthenticated");
  });

  test("credential scopes bound effective principal permissions", () => {
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute", credentialScopes: ["users.read"] }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute", credentialScopes: ["workflows.execute"] }).ok, true);
  });

  test("delegation is a subset of delegator authority and revocable", () => {
    const delegation = authorization.createDelegation({ delegatorPrincipalId: operator.principal_id, delegatePrincipalId: agent.principal_id, permissions: ["workflows.execute"], expiresAt: new Date(Date.now() + 60_000).toISOString(), actorPrincipalId: operator.principal_id });
    assert.strictEqual(authorization.authorize({ principalId: agent.principal_id, permission: "workflows.execute", delegationId: delegation.delegation_id }).ok, true);
    assert.strictEqual(authorization.authorize({ principalId: agent.principal_id, permission: "tools.execute", delegationId: delegation.delegation_id }).code, "forbidden");
    assert.throws(() => authorization.createDelegation({ delegatorPrincipalId: operator.principal_id, delegatePrincipalId: agent.principal_id, permissions: ["users.manage"] }), /lacks permission/);
    authorization.revokeDelegation(delegation.delegation_id, operator.principal_id);
    assert.strictEqual(authorization.authorize({ principalId: agent.principal_id, permission: "workflows.execute", delegationId: delegation.delegation_id }).code, "delegation-revoked-or-expired");
  });

  test("disabled principals cannot authorize", () => {
    identity.setPrincipalEnabled(operator.principal_id, false, owner.principal_id);
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute" }).code, "principal-disabled");
  });

  test("Owner promotion and final-Owner protection require authority", () => {
    assert.throws(() => identity.assignRole(agent.principal_id, "owner"), /authorized actor/);
    identity.assignRole(agent.principal_id, "owner", owner.principal_id);
    identity.setPrincipalEnabled(owner.principal_id, false, agent.principal_id);
    assert.throws(() => identity.removeRole(agent.principal_id, "owner", agent.principal_id), /final usable Owner/);
  });

  console.log(`Identity authorization: ${passed} passed`);
} finally {
  try { db.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
