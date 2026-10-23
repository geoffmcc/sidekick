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
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");
const db = dbStore.getDb();

const owner = identity.bootstrapOwner({ username: "atomic_owner", password: "synthetic sufficiently long owner password" });

function rejectAudit(eventType, triggerName, callback) {
  db.exec(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = '${eventType}'
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
  try { callback(); } finally { db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`); }
}

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

test("principal and human-user creation roll back completely when audit insertion fails", () => {
  rejectAudit("principal.created", "reject_principal_create_audit", () => {
    assert.throws(() => identity.createPrincipal({ type: "agent", displayName: "Audit rollback principal", actorPrincipalId: owner.principal_id }), /synthetic audit failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM principals WHERE display_name = ?").get("Audit rollback principal").count, 0);
  });
  rejectAudit("user.created", "reject_user_create_audit", () => {
    assert.throws(() => identity.createHumanUser({ username: "atomic_create_failure", password: "synthetic sufficiently long password", actorPrincipalId: owner.principal_id }), /synthetic audit failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM human_users WHERE username = ?").get("atomic_create_failure").count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM principals WHERE display_name = ?").get("atomic_create_failure").count, 0);
  });
});

test("profile, username, enabled-state, and password mutations roll back when audit insertion fails", () => {
  const user = identity.createHumanUser({ username: "atomic_profile_user", password: "synthetic sufficiently long original password", actorPrincipalId: owner.principal_id });
  rejectAudit("principal.updated", "reject_principal_update_audit", () => {
    assert.throws(() => identity.updatePrincipal(user.principal_id, { displayName: "Changed name" }, owner.principal_id), /synthetic audit failure/);
    assert.equal(identity.getPrincipal(user.principal_id).display_name, "atomic_profile_user");
  });
  rejectAudit("user.username_changed", "reject_username_audit", () => {
    assert.throws(() => identity.updateUsername(user.principal_id, "atomic_new_username", owner.principal_id), /synthetic audit failure/);
    assert.equal(identity.getHumanUser(user.principal_id).username, "atomic_profile_user");
  });
  rejectAudit("principal.disabled", "reject_principal_disable_audit", () => {
    assert.throws(() => identity.setPrincipalEnabled(user.principal_id, false, owner.principal_id), /synthetic audit failure/);
    assert.equal(identity.getPrincipal(user.principal_id).enabled, true);
  });
  const disableSession = authentication.createSession(user.principal_id);
  rejectAudit("principal.disabled", "reject_principal_disable_with_session_audit", () => {
    assert.throws(() => identity.setPrincipalEnabled(user.principal_id, false, owner.principal_id), /synthetic audit failure/);
    assert.ok(authentication.getSession(disableSession.token), "failed disable preserves the active session");
  });
  identity.setPrincipalEnabled(user.principal_id, false, owner.principal_id);
  assert.equal(identity.getPrincipal(user.principal_id).enabled, false);
  assert.equal(authentication.getSession(disableSession.token), null, "successful disable invalidates sessions transactionally");
  identity.setPrincipalEnabled(user.principal_id, true, owner.principal_id);
  const passwordSession = authentication.createSession(user.principal_id);
  rejectAudit("user.password_changed", "reject_password_audit", () => {
    assert.throws(() => identity.changePassword(user.principal_id, "synthetic sufficiently long changed password", owner.principal_id), /synthetic audit failure/);
    assert.ok(identity.verifyUserPassword("atomic_profile_user", "synthetic sufficiently long original password"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM identity_sessions WHERE principal_id = ? AND invalidated_at IS NOT NULL").get(user.principal_id).count, 1,
      "failed password mutation does not invalidate the active session");
  });
  identity.changePassword(user.principal_id, "synthetic sufficiently long changed password", owner.principal_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM identity_sessions WHERE principal_id = ? AND invalidated_at IS NULL").get(user.principal_id).count, 0,
    "successful password mutation invalidates active sessions transactionally");
  assert.ok(identity.verifyUserPassword("atomic_profile_user", "synthetic sufficiently long changed password"));
});

test("session, credential, and recovery-token issuance/revocation roll back with their audit rows", () => {
  const beforeSessions = db.prepare("SELECT COUNT(*) AS count FROM identity_sessions").get().count;
  rejectAudit("session.created", "reject_session_create_audit", () => {
    assert.throws(() => authentication.createSession(owner.principal_id), /synthetic audit failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM identity_sessions").get().count, beforeSessions);
  });

  const service = identity.createPrincipal({ type: "service", displayName: "Atomic audit service", actorPrincipalId: owner.principal_id });
  const beforeCredentials = db.prepare("SELECT COUNT(*) AS count FROM identity_credentials WHERE principal_id = ?").get(service.principal_id).count;
  rejectAudit("credential.created", "reject_credential_create_audit", () => {
    assert.throws(() => authentication.createCredential({ principalId: service.principal_id, displayName: "synthetic", scopes: ["memory.read"], createdByPrincipalId: owner.principal_id, actorContext: owner }), /synthetic audit failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM identity_credentials WHERE principal_id = ?").get(service.principal_id).count, beforeCredentials);
  });

  const created = authentication.createCredential({ principalId: service.principal_id, displayName: "synthetic", scopes: ["memory.read"], createdByPrincipalId: owner.principal_id, actorContext: owner });
  rejectAudit("credential.revoked", "reject_credential_revoke_audit", () => {
    assert.throws(() => authentication.revokeCredential(created.credential.credential_id, owner), /synthetic audit failure/);
    assert.equal(authentication.getCredential(created.credential.credential_id).revoked_at, null);
  });
  assert.equal(authentication.revokeCredential(created.credential.credential_id, owner), true);
  const revocationAudit = db.prepare("SELECT actor_principal_id FROM identity_audit_events WHERE event_type = 'credential.revoked' AND principal_id = ? ORDER BY created_at DESC LIMIT 1").get(service.principal_id);
  assert.equal(revocationAudit.actor_principal_id, owner.principal_id);

  const session = authentication.createSession(service.principal_id);
  rejectAudit("session.revoked", "reject_session_revoke_audit", () => {
    assert.throws(() => authentication.invalidateSession(session.token, owner.principal_id), /synthetic audit failure/);
    assert.ok(authentication.getSession(session.token), "failed single-session revocation preserves the active session");
  });
  assert.equal(authentication.invalidateSession(session.token, owner.principal_id), true);
  const sessionAudit = db.prepare("SELECT actor_principal_id, details_json FROM identity_audit_events WHERE event_type = 'session.revoked' AND principal_id = ? ORDER BY created_at DESC LIMIT 1").get(service.principal_id);
  assert.equal(sessionAudit.actor_principal_id, owner.principal_id);
  assert.equal(sessionAudit.details_json, "{}");

  const bulkSessions = [authentication.createSession(service.principal_id), authentication.createSession(service.principal_id)];
  rejectAudit("principal.sessions_revoked", "reject_bulk_session_revoke_audit", () => {
    assert.throws(() => authentication.invalidatePrincipalSessions(service.principal_id, owner.principal_id), /synthetic audit failure/);
    for (const active of bulkSessions) assert.ok(authentication.getSession(active.token), "failed bulk revocation preserves each active session");
  });
  assert.equal(authentication.invalidatePrincipalSessions(service.principal_id, owner.principal_id), 2);
  const bulkAudit = db.prepare("SELECT actor_principal_id, details_json FROM identity_audit_events WHERE event_type = 'principal.sessions_revoked' AND principal_id = ? ORDER BY created_at DESC LIMIT 1").get(service.principal_id);
  assert.equal(bulkAudit.actor_principal_id, owner.principal_id);
  assert.equal(JSON.parse(bulkAudit.details_json).count, 2);

  const beforeRecoveryTokens = db.prepare("SELECT COUNT(*) AS count FROM identity_recovery_tokens WHERE owner_principal_id = ?").get(owner.principal_id).count;
  rejectAudit("owner.recovery_token_created", "reject_recovery_token_audit", () => {
    assert.throws(() => authentication.createOwnerRecoveryToken(owner.principal_id), /synthetic audit failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM identity_recovery_tokens WHERE owner_principal_id = ?").get(owner.principal_id).count, beforeRecoveryTokens);
  });
});

test.after(() => {
  try { dbStore.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});
