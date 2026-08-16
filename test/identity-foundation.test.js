const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, `test-data-identity-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

try {
  test("migration creates durable identity tables", () => {
    for (const table of ["principals", "human_users", "principal_roles", "identity_bootstrap", "identity_audit_events"]) {
      assert.ok(db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
  });
  test("password hashing is salted, memory-hard, and verifier-only", () => {
    const first = identity.passwordHash("correct horse battery staple");
    const second = identity.passwordHash("correct horse battery staple");
    assert.notStrictEqual(first, second);
    assert.ok(first.startsWith(["scrypt", "v1"].join("_") + "$"));
    assert.strictEqual(identity.verifyPassword("correct horse battery staple", first), true);
    assert.strictEqual(identity.verifyPassword("wrong password", first), false);
  });
  test("bootstrap creates exactly one Owner and no password-bearing DTO", () => {
    const owner = identity.bootstrapOwner({ username: "geoff", password: "correct horse battery staple", displayName: "Geoffrey" });
    assert.strictEqual(owner.principal_type, "human");
    assert.deepStrictEqual(owner.roles, ["owner"]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(owner, "password_hash"), false);
    assert.throws(() => identity.bootstrapOwner({ username: "other", password: "another correct password" }), /already/);
    const stored = db.getDb().prepare("SELECT password_hash FROM human_users WHERE principal_id=?").get(owner.principal_id);
    assert.ok(stored.password_hash.startsWith(["scrypt", "v1"].join("_") + "$"));
  });
  test("bootstrap rejects short passwords and unsupported principal types", () => {
    assert.throws(() => identity.passwordHash("too short"), /at least 12/);
    assert.throws(() => identity.createPrincipal({ type: "root", displayName: "bad" }), /Unsupported principal type/);
  });
  test("human lifecycle preserves stable identity through rename-independent disable/enable", () => {
    const user = identity.createHumanUser({ username: "alice", password: "another correct password", displayName: "Alice" });
    const renamed = identity.updatePrincipal(user.principal_id, { displayName: "Alice Renamed" }, user.principal_id);
    assert.strictEqual(renamed.principal_id, user.principal_id);
    assert.strictEqual(renamed.display_name, "Alice Renamed");
    assert.strictEqual(identity.updateUsername(user.principal_id, "alice-renamed", user.principal_id).principal_id, user.principal_id);
    const disabled = identity.setPrincipalEnabled(user.principal_id, false, user.principal_id);
    assert.strictEqual(disabled.principal_id, user.principal_id);
    assert.strictEqual(disabled.enabled, false);
    assert.strictEqual(identity.verifyUserPassword("alice-renamed", "another correct password"), null);
    const enabled = identity.setPrincipalEnabled(user.principal_id, true, user.principal_id);
    assert.strictEqual(enabled.principal_id, user.principal_id);
    assert.ok(identity.verifyUserPassword("alice-renamed", "another correct password"));
  });
  test("non-human principals are typed and roles are explicit", () => {
    const agent = identity.createPrincipal({ type: "agent", displayName: "Claude Code" });
    assert.strictEqual(agent.principal_type, "agent");
    assert.deepStrictEqual(identity.assignRole(agent.principal_id, "operator", agent.principal_id).roles, ["operator"]);
    assert.throws(() => identity.assignRole(agent.principal_id, "root"), /Unsupported role/);
  });
  test("lifecycle audit contains stable principal IDs and no password material", () => {
    const rows = db.getDb().prepare("SELECT * FROM identity_audit_events ORDER BY created_at").all();
    assert.ok(rows.some(row => row.event_type === "bootstrap.owner_completed"));
    assert.ok(rows.every(row => !row.details_json.includes("correct horse")));
    assert.ok(rows.every(row => !row.details_json.includes(["scrypt", "v1"].join("_"))));
  });
  console.log(`Identity foundation: ${passed} passed`);
} finally {
  try { db.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
