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
    for (const permission of ["events.read", "events.manage", "sync.read", "sync.manage", "connectors.read", "connectors.manage"]) {
      assert.ok(db.getDb().prepare("SELECT 1 FROM identity_permissions WHERE permission = ?").get(permission), `${permission} is registered`);
      assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'administrator' AND permission = ?").get(permission), `administrator receives ${permission}`);
    }
    for (const permission of ["dashboard.operations.read", "dashboard.operations.manage", "dashboard.config.read", "dashboard.catalog.read", "predictions.read", "predictions.write", "scopes.read", "scopes.manage", "webhooks.receive", "network_scopes.read", "network_scopes.manage", "compute.nodes.read", "compute.jobs.read", "compute.nodes.manage", "compute.jobs.cancel", "compute.jobs.create", "compute.jobs.manage", "kv.read", "database.inspect"]) {
      assert.ok(db.getDb().prepare("SELECT 1 FROM identity_permissions WHERE permission = ?").get(permission), `${permission} is registered`);
      assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'administrator' AND permission = ?").get(permission), `administrator receives ${permission}`);
    }
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'administrator' AND permission = 'audit.read'").get());
    for (const permission of ["memory.read", "memory.write"]) {
      assert.ok(db.getDb().prepare("SELECT 1 FROM identity_permissions WHERE permission = ?").get(permission), `${permission} is registered`);
      assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'administrator' AND permission = ?").get(permission), `administrator receives ${permission}`);
      assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'operator' AND permission = ?").get(permission), `operator requires project membership for ${permission}`);
    }
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'operator' AND permission = 'predictions.read'").get());
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'viewer' AND permission = 'predictions.read'").get());
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'operator' AND permission = 'predictions.write'").get());
    assert.strictEqual(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'viewer' AND permission = 'predictions.write'").get(), undefined);
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'viewer' AND permission = 'memory.read'").get());
    assert.equal(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'viewer' AND permission = 'memory.write'").get(), undefined);
    assert.ok(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'auditor' AND permission = 'events.read'").get());
    assert.equal(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'auditor' AND permission LIKE 'sync.%'").get(), undefined, "auditors cannot export or mutate synchronized state");
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
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "connectors.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "connectors.manage" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "database.inspect" }).ok, true, "operator DB inspection workflow retains an explicit grant");
    const viewer = identity.createHumanUser({ username: "viewer_no_db", password: "another sufficiently long password" });
    identity.assignRole(viewer.principal_id, "viewer", owner.principal_id);
    assert.strictEqual(authorization.authorize({ principalId: viewer.principal_id, permission: "database.inspect" }).code, "forbidden", "viewer role does not receive database inspection");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "dashboard.operations.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "dashboard.operations.manage" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "dashboard.config.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "dashboard.catalog.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "compute.nodes.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "approvals.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "scopes.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "scopes.manage" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "webhooks.receive" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "network_scopes.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "network_scopes.manage" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "compute.nodes.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "compute.jobs.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "compute.nodes.manage" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "compute.jobs.cancel" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "compute.jobs.create" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "compute.jobs.manage" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "compute.jobs.recover" }).code, "forbidden");
    assert.equal(db.getDb().prepare("SELECT 1 FROM identity_role_permissions WHERE role_name = 'administrator' AND permission = 'compute.jobs.recover'").get(), undefined, "global lease recovery remains Owner-only");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "kv.read" }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "not.registered" }).code, "unknown-permission");
    assert.strictEqual(authorization.authorize({ principalId: null, permission: "workflows.execute" }).code, "unauthenticated");
  });

  test("credential scopes bound effective principal permissions", () => {
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute", credentialScopes: ["users.read"] }).code, "forbidden");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute", credentialScopes: ["workflows.execute"] }).ok, true);
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute", credentialScopes: [] }).code, "forbidden", "an explicitly empty machine credential scope grants no role permissions");
    assert.strictEqual(authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute", credentialScopes: null }).ok, true, "interactive principal sessions continue to use current role permissions");
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
