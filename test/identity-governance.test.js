const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, `test-data-identity-governance-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_SECRET_KEY = "identity-governance-test-key";
// This fixture exercises the Core authorization decision for an owner secret
// mutation. The production default is restricted/strict; opt into the legacy
// execution policy explicitly so this test isolates identity governance.
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
delete require.cache[require.resolve("../src/db")];
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const { buildProvenance } = require("../src/core/provenance");
const { callMcpTool } = require("../src/tools/dispatcher");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

(async () => {
  try {
    const owner = identity.bootstrapOwner({ username: "govowner", password: "correct horse battery staple", displayName: "Governance Owner" });
    const viewer = identity.createHumanUser({ username: "govviewer", password: "another correct password", displayName: "Governance Viewer" });
    identity.assignRole(viewer.principal_id, "viewer", owner.principal_id);

    test("provenance preserves principal fields without inventing identities", () => {
      assert.deepStrictEqual(buildProvenance({ authIdentity: { principal_id: owner.principal_id } }), {
        requested_by: owner.principal_id, actor: owner.principal_id, acting_for: null, approved_by: null, executed_by: null,
      });
      assert.strictEqual(buildProvenance({}).actor, null);
    });

    const unauthenticated = await callMcpTool("secret", { action: "list" }, {});
    test("secret operations require an authenticated principal", () => assert.strictEqual(unauthenticated.code, "unauthenticated"));

    const listed = await callMcpTool("secret", { action: "list" }, { authIdentity: { principal_id: viewer.principal_id } });
    test("metadata access uses the Core permission evaluator", () => {
      assert.notStrictEqual(listed.code, "authorization_denied");
      assert.notStrictEqual(listed.isError, true);
    });

    const disclosure = await callMcpTool("secret", { action: "get", key: "missing" }, { authIdentity: { principal_id: viewer.principal_id } });
    test("raw secret disclosure is distinct from metadata access", () => assert.strictEqual(disclosure.code, "authorization_denied"));

    const stored = await callMcpTool("secret", { action: "store", key: "demo", value: "do-not-log" }, { authIdentity: { principal_id: owner.principal_id } });
    const rotated = await callMcpTool("secret", { action: "rotate", key: "demo", generate: "24" }, { authIdentity: { principal_id: owner.principal_id } });
    test("secret mutation succeeds without returning raw rotation material", () => {
      assert.notStrictEqual(stored.isError, true);
      assert.notStrictEqual(rotated.isError, true);
      assert.ok(!String(rotated.content?.[0]?.text || "").includes("New value"));
    });

    const log = db.getDb().prepare("SELECT actor_principal_id, requested_by_principal_id, provenance_json, entry_json FROM tool_logs WHERE tool_name = 'secret' ORDER BY id DESC LIMIT 1").get();
    test("tool logs retain principal provenance and no raw secret", () => {
      assert.strictEqual(log.actor_principal_id, owner.principal_id);
      assert.strictEqual(log.requested_by_principal_id, owner.principal_id);
      assert.ok(log.provenance_json.includes(owner.principal_id));
      assert.ok(!log.entry_json.includes("do-not-log"));
    });

    const denial = db.getDb().prepare("SELECT details_json FROM identity_audit_events WHERE event_type = 'authorization.denied' ORDER BY created_at DESC LIMIT 1").get();
    test("authorization denial is recorded with safe details", () => {
      assert.ok(denial);
      assert.ok(denial.details_json.includes(viewer.principal_id));
      assert.ok(!denial.details_json.includes("do-not-log"));
    });

    console.log(`Identity governance: ${passed} passed`);
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(error); process.exit(1); });
