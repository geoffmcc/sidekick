"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-identity-audit-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const authorization = require("../src/core/authorization");
const db = dbStore.getDb();

const owner = identity.bootstrapOwner({ username: "atomic_owner", password: "synthetic sufficiently long owner password" });

test("role and delegation changes roll back when their audit record cannot be written", () => {
  const roleTarget = identity.createHumanUser({ username: "atomic_role_target", password: "synthetic sufficiently long role password" });
  db.exec(`CREATE TRIGGER reject_role_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type IN ('role.assigned', 'role.removed') AND NEW.principal_id = '${roleTarget.principal_id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
  try {
    assert.throws(() => identity.assignRole(roleTarget.principal_id, "operator", owner.principal_id), /synthetic audit failure/);
    assert.equal(authorization.authorize({ principalId: roleTarget.principal_id, permission: "workflows.execute" }).ok, false,
      "failed role grant leaves no authority behind");
  } finally {
    db.exec("DROP TRIGGER reject_role_audit");
  }

  identity.assignRole(roleTarget.principal_id, "operator", owner.principal_id);
  db.exec(`CREATE TRIGGER reject_role_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'role.removed' AND NEW.principal_id = '${roleTarget.principal_id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
  try {
    assert.throws(() => identity.removeRole(roleTarget.principal_id, "operator", owner.principal_id), /synthetic audit failure/);
    assert.equal(authorization.authorize({ principalId: roleTarget.principal_id, permission: "workflows.execute" }).ok, true,
      "failed role revocation preserves the prior authority state");
  } finally {
    db.exec("DROP TRIGGER reject_role_audit");
  }

  const delegate = identity.createPrincipal({ type: "agent", displayName: "Synthetic delegate", actorPrincipalId: owner.principal_id });
  db.exec(`CREATE TRIGGER reject_delegation_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type IN ('delegation.created', 'delegation.revoked') AND NEW.principal_id = '${delegate.principal_id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
  try {
    assert.throws(() => authorization.createDelegation({
      delegatorPrincipalId: owner.principal_id,
      delegatePrincipalId: delegate.principal_id,
      permissions: ["memory.read"],
    }), /synthetic audit failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM identity_delegations WHERE delegate_principal_id = ?").get(delegate.principal_id).count, 0,
      "failed delegation grant leaves no delegated authority behind");
  } finally {
    db.exec("DROP TRIGGER reject_delegation_audit");
  }

  const delegation = authorization.createDelegation({
    delegatorPrincipalId: owner.principal_id,
    delegatePrincipalId: delegate.principal_id,
    permissions: ["memory.read"],
  });
  db.exec(`CREATE TRIGGER reject_delegation_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'delegation.revoked' AND NEW.principal_id = '${delegate.principal_id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
  try {
    assert.throws(() => authorization.revokeDelegation(delegation.delegation_id, owner.principal_id), /synthetic audit failure/);
    assert.equal(authorization.getDelegation(delegation.delegation_id).revoked_at, null,
      "failed delegation revocation preserves the prior authority state");
  } finally {
    db.exec("DROP TRIGGER reject_delegation_audit");
  }
});

test.after(() => {
  try { dbStore.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});
