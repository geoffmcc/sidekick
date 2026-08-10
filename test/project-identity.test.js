const assert = require("assert");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-project-identity-" + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = DATA_DIR;
process.env.SIDEKICK_SECRET_KEY = "project-identity-test-secret-key";

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

  const result = platformKernel.backfillProjectSources();
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
  delete process.env.SIDEKICK_SECRET_KEY;
  try {
    assert.throws(() => platformKernel.setWorkspaceSecret(ws.workspace_id, "nope", "v"), /SIDEKICK_SECRET_KEY/);
    assert.throws(() => platformKernel.getWorkspaceSecret(ws.workspace_id, "api_key"), /SIDEKICK_SECRET_KEY/);
    const names = platformKernel.listWorkspaceSecretNames(ws.workspace_id);
    assert.deepStrictEqual(names, ["api_key"]);
  } finally {
    process.env.SIDEKICK_SECRET_KEY = prev;
  }
});

// PI.15: getProjectWorkspace exposes secret_names but never raw ciphertext
test("PI.15: getProjectWorkspace hides ciphertext", () => {
  const ws = platformKernel.getWorkspaceByProject("sec_p");
  const got = platformKernel.getProjectWorkspace(ws.workspace_id);
  assert.ok(!("envelope_json" in got));
  assert.ok(Array.isArray(got.secret_names));
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
