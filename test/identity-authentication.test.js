const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, `test-data-identity-auth-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

try {
  const owner = identity.bootstrapOwner({ username: "owner", password: "correct horse battery staple", displayName: "Owner" });
  const agent = identity.createPrincipal({ type: "agent", displayName: "Build Agent", createdByPrincipalId: owner.principal_id });
  identity.assignRole(agent.principal_id, "operator", owner.principal_id);
  const ownerContext = { principal_id: owner.principal_id };
  const packService = identity.createPrincipal({ type: "service", displayName: "MCP Pack Manager", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
  identity.grantPrincipalPermission(packService.principal_id, "packs.read", owner.principal_id);
  identity.grantPrincipalPermission(packService.principal_id, "packs.manage", owner.principal_id);
  const scopedRoleManager = identity.createPrincipal({ type: "service", displayName: "Scoped role manager", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
  identity.grantPrincipalPermission(scopedRoleManager.principal_id, "roles.manage", owner.principal_id);
  const scopedUserManager = identity.createPrincipal({ type: "service", displayName: "Scoped user manager", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
  identity.grantPrincipalPermission(scopedUserManager.principal_id, "users.manage", owner.principal_id);

  test("server-side browser sessions are opaque, expiring, and invalidatable", () => {
    const created = authentication.createSession(owner.principal_id, { userAgent: "test", ipAddress: "127.0.0.1" });
    assert.ok(created.token.length >= 40);
    assert.ok(authentication.getSession(created.token));
    const session = authentication.getSession(created.token);
    assert.ok(authentication.isSessionActive(session.session_id));
    assert.strictEqual(authentication.isSessionActive("invalid-session-id"), false);
    assert.strictEqual(db.getDb().prepare("SELECT session_id_hash FROM identity_sessions").get().session_id_hash.includes(created.token), false);
    assert.strictEqual(authentication.invalidateSession(created.token), true);
    assert.strictEqual(authentication.getSession(created.token), null);
    assert.strictEqual(authentication.isSessionActive(session.session_id), false, "long-lived streams can observe server-side logout immediately");
    const expiring = authentication.createSession(owner.principal_id);
    const expiringSession = authentication.getSession(expiring.token);
    db.getDb().prepare("UPDATE identity_sessions SET expires_at = ? WHERE session_id_hash = ?").run("2000-01-01T00:00:00.000Z", expiringSession.session_id);
    assert.strictEqual(authentication.isSessionActive(expiringSession.session_id), false, "expired sessions cannot retain long-lived stream access");
  });

  test("Core credential mutations require an authorized actor context", () => {
    const before = db.getDb().prepare("SELECT COUNT(*) AS count FROM identity_credentials").get().count;
    assert.throws(() => authentication.createCredential({ principalId: owner.principal_id, displayName: "Missing actor", scopes: [] }), /authenticated identity context/);
    assert.throws(() => authentication.createCredential({ principalId: agent.principal_id, displayName: "Unprivileged actor", scopes: ["tools.execute"], actorContext: { principal_id: agent.principal_id } }), /credentials.create/);
    assert.equal(db.getDb().prepare("SELECT COUNT(*) AS count FROM identity_credentials").get().count, before);

    const credential = authentication.createCredential({ principalId: owner.principal_id, displayName: "Owner-authorized", scopes: [], createdByPrincipalId: owner.principal_id, actorContext: ownerContext });
    assert.throws(() => authentication.revokeCredential(credential.credential.credential_id), /authenticated identity context/);
    assert.throws(() => authentication.rotateCredential(credential.credential.credential_id), /authenticated identity context/);
    assert.ok(authentication.authenticateCredential(credential.token), "denied lifecycle calls preserve the live credential");
  });

  test("identity role mutations preserve credential scope attenuation at the service boundary", () => {
    const target = identity.createPrincipal({ type: "service", displayName: "Scoped role target", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
    assert.throws(() => identity.assignRole(target.principal_id, "operator", { principal_id: scopedRoleManager.principal_id, scopes: [] }), /roles.manage/);
    identity.assignRole(target.principal_id, "operator", { principal_id: scopedRoleManager.principal_id, scopes: ["roles.manage"] });
    assert.ok(identity.getPrincipal(target.principal_id).roles.includes("operator"));
    assert.throws(() => identity.setPrincipalEnabled(target.principal_id, false, { principal_id: scopedRoleManager.principal_id, scopes: ["roles.manage"] }), /principals.manage/);
    assert.equal(identity.getPrincipal(target.principal_id).enabled, true);
  });

  test("identity profile and password mutations preserve credential scope attenuation", () => {
    const subject = identity.createHumanUser({ username: "scoped_subject", password: "synthetic scoped subject password", actorPrincipalId: owner.principal_id });
    const noScopes = { principal_id: scopedUserManager.principal_id, scopes: [] };
    const scoped = { principal_id: scopedUserManager.principal_id, scopes: ["users.manage"] };
    assert.throws(() => identity.updatePrincipal(subject.principal_id, { displayName: "Denied" }, noScopes), /users.manage/);
    assert.throws(() => identity.updateUsername(subject.principal_id, "denied_name", noScopes), /users.manage/);
    assert.throws(() => identity.changePassword(subject.principal_id, "synthetic denied password change", noScopes), /users.manage/);
    assert.equal(identity.updatePrincipal(subject.principal_id, { displayName: "Authorized" }, scoped).display_name, "Authorized");
    assert.equal(identity.updateUsername(subject.principal_id, "authorized_name", scoped).principal_id, subject.principal_id);
    identity.changePassword(subject.principal_id, "synthetic authorized password change", scoped);
  });

  test("scoped machine credential is revealed once and stores only a verifier", () => {
    const created = authentication.createCredential({ principalId: agent.principal_id, displayName: "Build API", scopes: ["tools.execute"], createdByPrincipalId: owner.principal_id, actorContext: ownerContext });
    assert.match(created.token, /^skc_cred_/);
    assert.ok(created.credential.credential_id);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(created.credential, "verifier_hash"), false);
    const stored = db.getDb().prepare("SELECT verifier_hash, token_prefix FROM identity_credentials WHERE credential_id = ?").get(created.credential.credential_id);
    assert.ok(stored.verifier_hash);
    assert.strictEqual(stored.verifier_hash.includes(created.token), false);
    assert.deepStrictEqual(authentication.authenticateCredential(created.token).scopes, ["tools.execute"]);
    assert.strictEqual(authentication.authenticateCredential(created.token).last_used_at !== null, true);
  });

  test("credential expiry and revocation deny future use", () => {
    const created = authentication.createCredential({ principalId: agent.principal_id, displayName: "Revocable API", scopes: [], expiresAt: new Date(Date.now() + 60_000).toISOString(), createdByPrincipalId: owner.principal_id, actorContext: ownerContext });
    assert.ok(authentication.authenticateCredential(created.token));
    assert.strictEqual(authentication.revokeCredential(created.credential.credential_id, ownerContext), true);
    assert.strictEqual(authentication.authenticateCredential(created.token), null);
    assert.strictEqual(authentication.revokeCredential(created.credential.credential_id, ownerContext), false);
  });

  test("a machine credential with no scopes grants none of its principal's role permissions", () => {
    const created = authentication.createCredential({ principalId: owner.principal_id, displayName: "Empty Scope API", scopes: [], createdByPrincipalId: owner.principal_id, actorContext: ownerContext });
    const authenticated = authentication.authenticateCredential(created.token);
    assert.deepStrictEqual(authenticated.scopes, []);
    assert.strictEqual(authorization.authorize({ principalId: owner.principal_id, permission: "tools.execute", credentialScopes: authenticated.scopes }).code, "forbidden");
  });

  test("dedicated service principals receive only explicitly granted and credential-scoped authority", () => {
    const credential = authentication.createCredential({
      principalId: packService.principal_id,
      displayName: "MCP pack management",
      scopes: ["packs.read", "packs.manage"],
      createdByPrincipalId: owner.principal_id,
      actorContext: ownerContext,
    });
    const authenticated = authentication.authenticateCredential(credential.token);
    assert.strictEqual(authenticated.principal_type, "service");
    assert.deepStrictEqual(authenticated.scopes, ["packs.read", "packs.manage"]);
    assert.strictEqual(authorization.authorize({ principalId: packService.principal_id, permission: "packs.manage", credentialScopes: authenticated.scopes }).ok, true);
    assert.strictEqual(authorization.authorize({ principalId: packService.principal_id, permission: "tools.execute", credentialScopes: authenticated.scopes }).code, "forbidden");
    assert.throws(() => identity.grantPrincipalPermission(packService.principal_id, "tools.execute", packService.principal_id), /roles.manage/);
    assert.throws(() => identity.revokePrincipalPermission(packService.principal_id, "packs.read", packService.principal_id), /roles.manage/);
    assert.deepStrictEqual(identity.getPrincipalPermissions(packService.principal_id), ["packs.manage", "packs.read"], "a service principal cannot rewrite its own grants");
    identity.revokePrincipalPermission(packService.principal_id, "packs.manage", owner.principal_id);
    assert.strictEqual(authorization.authorize({ principalId: packService.principal_id, permission: "packs.manage", credentialScopes: authenticated.scopes }).code, "forbidden", "revoking the principal grant takes effect for existing credentials");
  });

  test("credential rotation creates a replacement and revokes the old token", () => {
    const created = authentication.createCredential({ principalId: agent.principal_id, displayName: "Rotating API", scopes: ["tools.execute"], createdByPrincipalId: owner.principal_id, actorContext: ownerContext });
    const replacement = authentication.rotateCredential(created.credential.credential_id, ownerContext);
    assert.notStrictEqual(replacement.credential.credential_id, created.credential.credential_id);
    assert.strictEqual(authentication.authenticateCredential(created.token), null);
    assert.ok(authentication.authenticateCredential(replacement.token));
  });

  test("disabled principals invalidate both sessions and credentials", () => {
    const created = authentication.createCredential({ principalId: agent.principal_id, displayName: "Disable API", scopes: [], createdByPrincipalId: owner.principal_id, actorContext: ownerContext });
    const session = authentication.createSession(agent.principal_id);
    identity.setPrincipalEnabled(agent.principal_id, false, owner.principal_id);
    assert.strictEqual(authentication.authenticateCredential(created.token), null);
    assert.strictEqual(authentication.getSession(session.token), null);
  });

  test("authentication audit contains identifiers but never raw credential material", () => {
    const rows = db.getDb().prepare("SELECT event_type, details_json FROM identity_audit_events WHERE event_type LIKE 'credential.%' OR event_type = 'session.created'").all();
    assert.ok(rows.some(row => row.event_type === "credential.created"));
    assert.ok(rows.every(row => !row.details_json.includes("skc_cred_")));
  });

  test("Owner recovery is local-token, one-time, expiry-bound, and invalidates sessions", () => {
    const session = authentication.createSession(owner.principal_id);
    const recovery = authentication.createOwnerRecoveryToken(owner.principal_id);
    assert.ok(recovery.token);
    assert.ok(authentication.recoverOwnerPassword(recovery.token, "new correct horse battery staple"));
    assert.strictEqual(authentication.getSession(session.token), null);
    assert.throws(() => authentication.recoverOwnerPassword(recovery.token, "another correct horse battery"), /invalid|expired/);
    const rows = db.getDb().prepare("SELECT token_hash FROM identity_recovery_tokens").all();
    assert.ok(rows.every(row => !row.token_hash.includes(recovery.token)));
  });

  console.log(`Identity authentication: ${passed} passed`);
} finally {
  try { db.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
