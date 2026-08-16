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

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

try {
  const owner = identity.bootstrapOwner({ username: "owner", password: "correct horse battery staple", displayName: "Owner" });
  const agent = identity.createPrincipal({ type: "agent", displayName: "Build Agent", createdByPrincipalId: owner.principal_id });

  test("server-side browser sessions are opaque, expiring, and invalidatable", () => {
    const created = authentication.createSession(owner.principal_id, { userAgent: "test", ipAddress: "127.0.0.1" });
    assert.ok(created.token.length >= 40);
    assert.ok(authentication.getSession(created.token));
    assert.strictEqual(db.getDb().prepare("SELECT session_id_hash FROM identity_sessions").get().session_id_hash.includes(created.token), false);
    assert.strictEqual(authentication.invalidateSession(created.token), true);
    assert.strictEqual(authentication.getSession(created.token), null);
  });

  test("scoped machine credential is revealed once and stores only a verifier", () => {
    const created = authentication.createCredential({ principalId: agent.principal_id, displayName: "Build API", scopes: ["build.read"] });
    assert.match(created.token, /^skc_cred_/);
    assert.ok(created.credential.credential_id);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(created.credential, "verifier_hash"), false);
    const stored = db.getDb().prepare("SELECT verifier_hash, token_prefix FROM identity_credentials WHERE credential_id = ?").get(created.credential.credential_id);
    assert.ok(stored.verifier_hash);
    assert.strictEqual(stored.verifier_hash.includes(created.token), false);
    assert.deepStrictEqual(authentication.authenticateCredential(created.token).scopes, ["build.read"]);
    assert.strictEqual(authentication.authenticateCredential(created.token).last_used_at !== null, true);
  });

  test("credential expiry and revocation deny future use", () => {
    const created = authentication.createCredential({ principalId: agent.principal_id, displayName: "Revocable API", scopes: [], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.ok(authentication.authenticateCredential(created.token));
    assert.strictEqual(authentication.revokeCredential(created.credential.credential_id), true);
    assert.strictEqual(authentication.authenticateCredential(created.token), null);
    assert.strictEqual(authentication.revokeCredential(created.credential.credential_id), false);
  });

  test("credential rotation creates a replacement and revokes the old token", () => {
    const created = authentication.createCredential({ principalId: agent.principal_id, displayName: "Rotating API", scopes: ["rotate.read"] });
    const replacement = authentication.rotateCredential(created.credential.credential_id, owner.principal_id);
    assert.notStrictEqual(replacement.credential.credential_id, created.credential.credential_id);
    assert.strictEqual(authentication.authenticateCredential(created.token), null);
    assert.ok(authentication.authenticateCredential(replacement.token));
  });

  test("disabled principals invalidate both sessions and credentials", () => {
    const created = authentication.createCredential({ principalId: agent.principal_id, displayName: "Disable API", scopes: [] });
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
