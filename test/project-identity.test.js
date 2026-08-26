const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-project-identity-" + Date.now());
const SECRET_DIR = path.join(os.tmpdir(), "sidekick-test-secrets-project-identity-" + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(SECRET_DIR, "sidekick_secret_key"), "project-identity-test-secret-key\n", { mode: 0o600 });
process.env.SIDEKICK_DATA_DIR = DATA_DIR;
process.env.SIDEKICK_SECRET_DIR = SECRET_DIR;
delete process.env.SIDEKICK_SECRET_KEY;

delete require.cache[require.resolve("../src/db")];
delete require.cache[require.resolve("../src/platform/kernel")];
delete require.cache[require.resolve("../src/platform/kernel-schema")];
delete require.cache[require.resolve("../src/core/secret-cipher")];

const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const platformKernel = require("../src/platform/kernel");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
  }
}

function cleanup() {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SECRET_DIR, { recursive: true, force: true }); } catch {}
}

// createProjectWorkspace no longer writes plaintext, so legacy rows that
// predate the encrypted store are simulated with direct SQL.
function seedLegacySecrets(workspaceId, secrets) {
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET secrets_json = ? WHERE workspace_id = ?").run(JSON.stringify(secrets), workspaceId);
}

// PI.1: registerProject creates an idempotent canonical project row
test("PI.1: registerProject creates idempotent project", () => {
  const first = platformKernel.registerProject({ project_id: "alpha", display_name: "Alpha", owner_actor_id: "admin" });
  platformKernel.registerProject({ project_id: "alpha", display_name: "Alpha", owner_actor_id: "admin" });
  assert.strictEqual(first.project_id, "alpha");
  assert.strictEqual(first.display_name, "Alpha");
  assert.strictEqual(first.state, "active");
  const rows = dbStore.getDb().prepare("SELECT COUNT(*) AS c FROM platform_projects WHERE project_id = ?").get("alpha");
  assert.strictEqual(rows.c, 1);
});

// PI.2: registerProject rejects empty project_id
test("PI.2: registerProject rejects empty project_id", () => {
  assert.throws(() => platformKernel.registerProject({ project_id: "" }), /non-empty/);
  assert.throws(() => platformKernel.registerProject({ project_id: "   " }), /non-empty/);
  assert.throws(() => platformKernel.registerProject({ project_id: 42 }), /non-empty/);
});

// PI.3: getProject normalizes metadata and returns null for missing
test("PI.3: getProject normalizes and misses safely", () => {
  platformKernel.registerProject({ project_id: "beta", metadata: { region: "us-east" } });
  const got = platformKernel.getProject("beta");
  assert.deepStrictEqual(got.metadata, { region: "us-east" });
  assert.strictEqual(platformKernel.getProject("missing"), null);
});

// PI.4: listProjects filters by state and limit
test("PI.4: listProjects filters by state and limit", () => {
  platformKernel.registerProject({ project_id: "gamma" });
  const active = platformKernel.listProjects({ state: "active" });
  assert.ok(active.some(p => p.project_id === "gamma"));
  const limited = platformKernel.listProjects({ limit: 1 });
  assert.strictEqual(limited.length, 1);
  assert.throws(() => platformKernel.listProjects({ state: "bogus" }), /Invalid project state/);
});

// PI.5: archiveProject archives and excludes from active list
test("PI.5: archiveProject archives project", () => {
  platformKernel.registerProject({ project_id: "delta" });
  const archived = platformKernel.archiveProject("delta", { reason: "retired" });
  assert.strictEqual(archived.state, "archived");
  assert.ok(archived.archived_at);
  assert.strictEqual(platformKernel.listProjects({ state: "active" }).some(p => p.project_id === "delta"), false);
  assert.throws(() => platformKernel.archiveProject("does_not_exist"), /not found/);
});

// PI.6: recordProjectSource auto-registers project and increments count
test("PI.6: recordProjectSource records and increments", () => {
  const row = platformKernel.recordProjectSource("eps", "custom", "ref-1", { metadata: { k: "v" } });
  assert.strictEqual(row.count, 1);
  assert.strictEqual(platformKernel.getProject("eps").state, "active");
  const again = platformKernel.recordProjectSource("eps", "custom", "ref-1");
  assert.strictEqual(again.count, 2);
});

// PI.7: recordProjectSource rejects unknown source
test("PI.7: recordProjectSource rejects unknown source", () => {
  assert.throws(() => platformKernel.recordProjectSource("eps", "bogus", "x"), /Invalid project source/);
});

// PI.8: getProjectsBySource reverse lookup
test("PI.8: getProjectsBySource reverse lookup", () => {
  platformKernel.recordProjectSource("zeta", "custom", "shared-ref");
  platformKernel.recordProjectSource("eta", "custom", "shared-ref");
  const rows = platformKernel.getProjectsBySource("custom", "shared-ref");
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every(r => r.source_id === "shared-ref"));
});

// PI.9: backfillProjectSources writes absolute counts per (project, source, '*')
test("PI.9: backfillProjectSources aggregates across stores", () => {
  const ts = new Date().toISOString();
  const kv = dbStore.getDb().prepare("INSERT INTO kv_store (key, value_json, project) VALUES (?, '{}', ?)");
  kv.run("b_k1", "backfill_p");
  kv.run("b_k2", "backfill_p");
  kv.run("b_k3", "backfill_q");
  const mem = dbStore.getDb().prepare("INSERT INTO memories (id, type, project, content) VALUES (?, 'fact', ?, 'x')");
  mem.run("b_m1", "backfill_p");
  mem.run("b_m2", "backfill_p");
  dbStore.getDb().prepare("INSERT INTO platform_executions (execution_id, root_execution_id, operation_type, state, updated_at) VALUES ('b_e1', 'b_e1', 'test', 'created', ?)").run(ts);
  dbStore.getDb().prepare("UPDATE platform_executions SET project_id = 'backfill_p' WHERE execution_id = 'b_e1'").run();
  platformKernel.createProjectWorkspace({ name: "bf", project_id: "backfill_p" });

  const result = platformKernel.backfillProjectSources({ dry_run: false });
  assert.ok(result.written >= 4);
  const kvRow = platformKernel.getProjectSources("backfill_p").find(r => r.source === "kv" && r.source_id === "*");
  assert.strictEqual(kvRow.count, 2);
  const memRow = platformKernel.getProjectSources("backfill_p").find(r => r.source === "memory" && r.source_id === "*");
  assert.strictEqual(memRow.count, 2);
  const wsRow = platformKernel.getProjectSources("backfill_p").find(r => r.source === "workspace" && r.source_id === "*");
  assert.strictEqual(wsRow.count, 1);
  const execRow = platformKernel.getProjectSources("backfill_p").find(r => r.source === "execution" && r.source_id === "*");
  assert.strictEqual(execRow.count, 1);
  assert.strictEqual(platformKernel.getProjectSources("backfill_q").find(r => r.source === "kv").count, 1);

  // Canonical project variants must be aggregated before the upsert, rather
  // than overwriting one variant's count with the other.
  kv.run("b_k4", "Backfill-P");
  const merged = platformKernel.backfillProjectSources({ dry_run: false });
  assert.ok(merged.written >= 4);
  assert.strictEqual(platformKernel.getProjectSources("backfill_p").find(r => r.source === "kv" && r.source_id === "*").count, 3);
});

// PI.10: project sources are isolated across projects
test("PI.10: sources are isolated across projects", () => {
  platformKernel.recordProjectSource("only_a", "custom", "iso");
  const sources = platformKernel.getProjectSources("only_a");
  assert.ok(sources.length > 0);
  assert.strictEqual(platformKernel.getProjectSources("only_b").length, 0);
});

// PI.11: setWorkspaceSecret stores an encrypted envelope, never plaintext
test("PI.11: setWorkspaceSecret encrypts at rest", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "sec", project_id: "sec_p" });
  const updated = platformKernel.setWorkspaceSecret(ws.workspace_id, "api_key", "super-secret-value");
  assert.deepStrictEqual(updated.secret_names, ["api_key"]);
  const row = dbStore.getDb().prepare("SELECT envelope_json FROM platform_workspace_secrets WHERE workspace_id = ? AND secret_name = 'api_key'").get(ws.workspace_id);
  assert.ok(row.envelope_json.includes("iv"));
  assert.ok(row.envelope_json.includes("authTag"));
  assert.ok(!row.envelope_json.includes("super-secret-value"));
});

// PI.12: getWorkspaceSecret roundtrips the value
test("PI.12: getWorkspaceSecret roundtrips", () => {
  const ws = platformKernel.getWorkspaceByProject("sec_p");
  assert.strictEqual(platformKernel.getWorkspaceSecret(ws.workspace_id, "api_key"), "super-secret-value");
  assert.strictEqual(platformKernel.getWorkspaceSecret(ws.workspace_id, "missing"), null);
  assert.strictEqual(platformKernel.getWorkspaceSecret("ws_does_not_exist", "api_key"), null);
});

// PI.13: deleteWorkspaceSecret removes the secret
test("PI.13: deleteWorkspaceSecret removes", () => {
  const ws = platformKernel.getWorkspaceByProject("sec_p");
  platformKernel.setWorkspaceSecret(ws.workspace_id, "temp", "scratch");
  assert.deepStrictEqual(platformKernel.listWorkspaceSecretNames(ws.workspace_id), ["api_key", "temp"]);
  const deleted = platformKernel.deleteWorkspaceSecret(ws.workspace_id, "temp");
  assert.strictEqual(deleted.deleted, true);
  assert.strictEqual(platformKernel.getWorkspaceSecret(ws.workspace_id, "temp"), null);
  assert.deepStrictEqual(platformKernel.listWorkspaceSecretNames(ws.workspace_id), ["api_key"]);
  assert.strictEqual(platformKernel.deleteWorkspaceSecret(ws.workspace_id, "temp").deleted, false);
});

// PI.14: secret methods fail closed without SIDEKICK_SECRET_KEY
test("PI.14: secret methods fail closed without key", () => {
  const ws = platformKernel.getWorkspaceByProject("sec_p");
  const prev = process.env.SIDEKICK_SECRET_KEY;
  const prevDir = process.env.SIDEKICK_SECRET_DIR;
  delete process.env.SIDEKICK_SECRET_KEY;
  delete process.env.SIDEKICK_SECRET_DIR;
  try {
    assert.throws(() => platformKernel.setWorkspaceSecret(ws.workspace_id, "nope", "v"), /SIDEKICK_SECRET_KEY/);
    assert.throws(() => platformKernel.getWorkspaceSecret(ws.workspace_id, "api_key"), /SIDEKICK_SECRET_KEY/);
    const names = platformKernel.listWorkspaceSecretNames(ws.workspace_id);
    assert.deepStrictEqual(names, ["api_key"]);
  } finally {
    process.env.SIDEKICK_SECRET_KEY = prev;
    process.env.SIDEKICK_SECRET_DIR = prevDir;
  }
});

// PI.15: getProjectWorkspace exposes secret_names but never raw ciphertext
test("PI.15: getProjectWorkspace hides ciphertext", () => {
  const ws = platformKernel.getWorkspaceByProject("sec_p");
  const got = platformKernel.getProjectWorkspace(ws.workspace_id);
  assert.ok(!("envelope_json" in got));
  assert.ok(Array.isArray(got.secret_names));
});

// PI.16: backfillWorkspaceSecrets migrates legacy plaintext into envelopes and clears it
test("PI.16: backfillWorkspaceSecrets migrates and clears plaintext", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "legacy", project_id: "legacy_p" });
  seedLegacySecrets(ws.workspace_id, { token: "legacy-token-value", nested: { a: 1 } });
  const before = dbStore.getDb().prepare("SELECT secrets_json FROM platform_project_workspaces WHERE workspace_id = ?").get(ws.workspace_id);
  assert.ok(before.secrets_json.includes("legacy-token-value"));
  const result = platformKernel.backfillWorkspaceSecrets();
  assert.strictEqual(result.workspaces_migrated, 1);
  assert.strictEqual(result.secrets_migrated, 2);
  assert.deepStrictEqual(result.workspaces_unreadable, []);
  assert.strictEqual(platformKernel.getWorkspaceSecret(ws.workspace_id, "token"), "legacy-token-value");
  assert.strictEqual(platformKernel.getWorkspaceSecret(ws.workspace_id, "nested"), '{"a":1}');
  const after = dbStore.getDb().prepare("SELECT secrets_json FROM platform_project_workspaces WHERE workspace_id = ?").get(ws.workspace_id);
  assert.strictEqual(after.secrets_json, "{}");
  const envelope = dbStore.getDb().prepare("SELECT envelope_json FROM platform_workspace_secrets WHERE workspace_id = ? AND secret_name = 'token'").get(ws.workspace_id);
  assert.ok(!envelope.envelope_json.includes("legacy-token-value"));
  assert.deepStrictEqual(platformKernel.listWorkspaceSecretNames(ws.workspace_id), ["nested", "token"]);
});

// PI.17: backfill never overwrites an existing envelope and re-runs migrate nothing
test("PI.17: backfillWorkspaceSecrets skips existing envelopes and is idempotent", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "dupe", project_id: "dupe_p" });
  seedLegacySecrets(ws.workspace_id, { dupe: "stale-plaintext" });
  platformKernel.setWorkspaceSecret(ws.workspace_id, "dupe", "current-encrypted");
  const result = platformKernel.backfillWorkspaceSecrets();
  assert.strictEqual(result.secrets_skipped_existing, 1);
  assert.strictEqual(platformKernel.getWorkspaceSecret(ws.workspace_id, "dupe"), "current-encrypted");
  const again = platformKernel.backfillWorkspaceSecrets();
  assert.strictEqual(again.workspaces_scanned, 0);
  assert.strictEqual(again.secrets_migrated, 0);
});

// PI.18: backfill fails closed without SIDEKICK_SECRET_KEY, leaving plaintext untouched
test("PI.18: backfillWorkspaceSecrets fails closed without key", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "closed", project_id: "closed_p" });
  seedLegacySecrets(ws.workspace_id, { held: "still-plaintext" });
  const prev = process.env.SIDEKICK_SECRET_KEY;
  const prevDir = process.env.SIDEKICK_SECRET_DIR;
  delete process.env.SIDEKICK_SECRET_KEY;
  delete process.env.SIDEKICK_SECRET_DIR;
  try {
    assert.throws(() => platformKernel.backfillWorkspaceSecrets(), /SIDEKICK_SECRET_KEY/);
  } finally {
    process.env.SIDEKICK_SECRET_KEY = prev;
    process.env.SIDEKICK_SECRET_DIR = prevDir;
  }
  const row = dbStore.getDb().prepare("SELECT secrets_json FROM platform_project_workspaces WHERE workspace_id = ?").get(ws.workspace_id);
  assert.ok(row.secrets_json.includes("still-plaintext"));
  assert.strictEqual(platformKernel.backfillWorkspaceSecrets().secrets_migrated, 1);
});

// PI.19: unreadable secrets_json is reported and left untouched
test("PI.19: backfillWorkspaceSecrets leaves unreadable secrets_json alone", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "corrupt", project_id: "corrupt_p" });
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET secrets_json = 'not-json' WHERE workspace_id = ?").run(ws.workspace_id);
  const result = platformKernel.backfillWorkspaceSecrets();
  assert.deepStrictEqual(result.workspaces_unreadable, [ws.workspace_id]);
  assert.strictEqual(result.workspaces_migrated, 0);
  const row = dbStore.getDb().prepare("SELECT secrets_json FROM platform_project_workspaces WHERE workspace_id = ?").get(ws.workspace_id);
  assert.strictEqual(row.secrets_json, "not-json");
});

// PI.20: a non-null value under an empty name keeps the plaintext copy alive
test("PI.20: backfillWorkspaceSecrets retains plaintext for unaddressable names", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "noname", project_id: "noname_p" });
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET secrets_json = ? WHERE workspace_id = ?").run('{"":"orphan-value","ok":"good-value"}', ws.workspace_id);
  const result = platformKernel.backfillWorkspaceSecrets();
  assert.deepStrictEqual(result.workspaces_retained, [ws.workspace_id]);
  assert.strictEqual(result.workspaces_migrated, 0);
  assert.strictEqual(platformKernel.getWorkspaceSecret(ws.workspace_id, "ok"), "good-value");
  const row = dbStore.getDb().prepare("SELECT secrets_json FROM platform_project_workspaces WHERE workspace_id = ?").get(ws.workspace_id);
  assert.ok(row.secrets_json.includes("orphan-value"));
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET secrets_json = '{}' WHERE workspace_id = ?").run(ws.workspace_id);
});

// PI.21: plaintext survives when the existing envelope no longer decrypts
test("PI.21: backfillWorkspaceSecrets retains plaintext for undecryptable envelopes", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "rotated", project_id: "rotated_p" });
  seedLegacySecrets(ws.workspace_id, { rot: "last-good-copy" });
  const ts = new Date().toISOString();
  dbStore.getDb().prepare("INSERT INTO platform_workspace_secrets (workspace_id, secret_name, envelope_json, created_at, updated_at) VALUES (?, 'rot', ?, ?, ?)").run(ws.workspace_id, '{"iv":"00000000000000000000000000000000","data":"00","authTag":"00000000000000000000000000000000"}', ts, ts);
  const result = platformKernel.backfillWorkspaceSecrets();
  assert.deepStrictEqual(result.workspaces_retained, [ws.workspace_id]);
  assert.strictEqual(result.secrets_skipped_existing, 1);
  const row = dbStore.getDb().prepare("SELECT secrets_json FROM platform_project_workspaces WHERE workspace_id = ?").get(ws.workspace_id);
  assert.ok(row.secrets_json.includes("last-good-copy"));
  dbStore.getDb().prepare("UPDATE platform_project_workspaces SET secrets_json = '{}' WHERE workspace_id = ?").run(ws.workspace_id);
});

// PI.22: casing/charset variants converge to one canonical project (B3 fork fix)
test("PI.22: registerProject canonicalizes casing and charset to one identity", () => {
  const a = platformKernel.registerProject({ project_id: "MixedCase", owner_actor_id: "admin" });
  assert.strictEqual(a.project_id, "mixedcase", "canonical id is lowercased");
  // A second register with different casing must not fork a new row.
  platformKernel.registerProject({ project_id: "MIXEDCASE" });
  platformKernel.registerProject({ project_id: "mixedcase" });
  const rows = dbStore.getDb().prepare("SELECT COUNT(*) AS c FROM platform_projects WHERE project_id = 'mixedcase'").get();
  assert.strictEqual(rows.c, 1, "casing variants must not fork the canonical row");
  // Lookups by any casing resolve to the one row.
  assert.strictEqual(platformKernel.getProject("MixedCase").project_id, "mixedcase");
  assert.strictEqual(platformKernel.getProject("mixedcase").project_id, "mixedcase");
  // Charset normalization: spaces/dashes collapse to underscores.
  const b = platformKernel.registerProject({ project_id: "My Cool-Project" });
  assert.strictEqual(b.project_id, "my_cool_project");
});

// PI.23: the caller's original spelling is preserved when canonicalization changed it
test("PI.23: registerProject preserves original spelling in metadata and display", () => {
  const p = platformKernel.registerProject({ project_id: "CamelProj" });
  assert.strictEqual(p.project_id, "camelproj");
  assert.strictEqual(p.display_name, "CamelProj", "original spelling kept as display label");
  assert.strictEqual(p.metadata.original_project_id, "CamelProj");
  // An explicit display_name still wins, and an already-canonical id adds no metadata noise.
  const q = platformKernel.registerProject({ project_id: "plainproj", display_name: "Plain" });
  assert.strictEqual(q.display_name, "Plain");
  assert.strictEqual(q.metadata.original_project_id, undefined, "no original stamped when nothing changed");
});

// PI.24: type/empty validation survives canonicalization
test("PI.24: registerProject still rejects non-string and empty ids", () => {
  assert.throws(() => platformKernel.registerProject({ project_id: 42 }), /non-empty/);
  assert.throws(() => platformKernel.registerProject({ project_id: "" }), /non-empty/);
  assert.throws(() => platformKernel.registerProject({ project_id: "   " }), /non-empty/);
  assert.throws(() => platformKernel.registerProject({ project_id: "!!!" }), /non-empty/, "charset-only input canonicalizes to empty and is rejected");
});

test("PI.25: execution creation registers and canonicalizes its project", () => {
  const execution = platformKernel.createExecution({
    operation_type: "project_registration_test",
    project_id: "Execution Project",
    actor_id: "test-actor",
    source: "test",
  });
  assert.strictEqual(execution.project_id, "execution_project");
  const project = platformKernel.getProject("execution_project");
  assert.ok(project, "execution project should be registered automatically");
  assert.strictEqual(project.owner_actor_id, "test-actor");
});

// PI.25: recordProjectSource keeps the FK consistent under canonicalization
test("PI.25: recordProjectSource canonicalizes so the source FK resolves", () => {
  const src = platformKernel.recordProjectSource("FkProj", "kv", "key1");
  assert.strictEqual(src.project_id, "fkproj");
  // The parent project row exists under the canonical id (FK satisfied, no throw above).
  assert.ok(platformKernel.getProject("FkProj"));
  const sources = platformKernel.getProjectSources("fkproj");
  assert.ok(sources.some(s => s.source === "kv" && s.source_id === "key1"));
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
