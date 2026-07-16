const assert = require("assert");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-backup-release-" + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = DATA_DIR;

delete require.cache[require.resolve("../src/db")];
delete require.cache[require.resolve("../src/platform/kernel")];

const dbStore = require("../src/db");
const platformKernel = require("../src/platform/kernel");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function cleanup() {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

// BK.1: createBackup creates backup with row counts
test("BK.1: createBackup creates backup with row counts", () => {
  const bk = platformKernel.createBackup({ name: "full_backup", type: "full", actor_id: "admin" });
  assert.ok(bk.backup_id);
  assert.strictEqual(bk.name, "full_backup");
  assert.strictEqual(bk.state, "created");
  assert.strictEqual(bk.type, "full");
});

// BK.2: getBackup returns parsed fields
test("BK.2: getBackup returns parsed fields", () => {
  const bk = platformKernel.createBackup({ name: "parsed_backup", tables: ["platform_executions", "platform_model_registry"], metadata: { env: "prod" } });
  const got = platformKernel.getBackup(bk.backup_id);
  assert.ok(Array.isArray(got.tables_included));
  assert.strictEqual(got.tables_included.length, 2);
  assert.deepStrictEqual(got.metadata, { env: "prod" });
});

// BK.3: completeBackup marks completed
test("BK.3: completeBackup marks completed", () => {
  const bk = platformKernel.createBackup({ name: "complete_test" });
  const completed = platformKernel.completeBackup(bk.backup_id, { file_path: "/backups/full.bak", file_size_bytes: 1024, checksum: "abc123" });
  assert.strictEqual(completed.state, "completed");
  assert.ok(completed.completed_at);
  assert.strictEqual(completed.file_path, "/backups/full.bak");
});

// BK.4: restoreBackup marks restored
test("BK.4: restoreBackup marks restored", () => {
  const bk = platformKernel.createBackup({ name: "restore_test" });
  platformKernel.completeBackup(bk.backup_id, { file_path: "/backups/restore.bak" });
  const restored = platformKernel.restoreBackup(bk.backup_id, { actor_id: "admin" });
  assert.strictEqual(restored.state, "restored");
  assert.ok(restored.restored_at);
});

// BK.5: listBackups lists all
test("BK.5: listBackups lists all", () => {
  platformKernel.createBackup({ name: "list_bk_a" });
  platformKernel.createBackup({ name: "list_bk_b" });
  const all = platformKernel.listBackups();
  assert.ok(all.length >= 2);
});

// BK.6: listBackups filters by state
test("BK.6: listBackups filters by state", () => {
  const bk = platformKernel.createBackup({ name: "filter_bk" });
  platformKernel.completeBackup(bk.backup_id);
  const completed = platformKernel.listBackups({ state: "completed" });
  assert.ok(completed.every(b => b.state === "completed"));
});

// BK.7: backup emits events
test("BK.7: backup emits events", () => {
  const bk = platformKernel.createBackup({ name: "events_bk" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'backup.created' AND subject_id = ?").all(bk.backup_id);
  assert.ok(events.length > 0);
});

// BK.8: complete emits event
test("BK.8: complete emits event", () => {
  const bk = platformKernel.createBackup({ name: "complete_event_bk" });
  platformKernel.completeBackup(bk.backup_id, { file_path: "/test.bak" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'backup.completed' AND subject_id = ?").all(bk.backup_id);
  assert.ok(events.length > 0);
});

// RL.1: createRelease creates release
test("RL.1: createRelease creates release", () => {
  const rel = platformKernel.createRelease({ version: "1.0.0", codename: "Phoenix", description: "First release", changelog: ["Initial platform kernel", "Tool catalog"], released_by: "admin" });
  assert.ok(rel.release_id);
  assert.strictEqual(rel.version, "1.0.0");
  assert.strictEqual(rel.codename, "Phoenix");
  assert.strictEqual(rel.state, "draft");
});

// RL.2: getRelease returns parsed fields
test("RL.2: getRelease returns parsed fields", () => {
  const rel = platformKernel.createRelease({ version: "1.1.0", changelog: ["Feature A"], breaking_changes: ["Removed old API"], deprecations: ["Legacy auth"], metadata: { team: "platform" } });
  const got = platformKernel.getRelease(rel.release_id);
  assert.deepStrictEqual(got.changelog, ["Feature A"]);
  assert.deepStrictEqual(got.breaking_changes, ["Removed old API"]);
  assert.deepStrictEqual(got.deprecations, ["Legacy auth"]);
  assert.deepStrictEqual(got.metadata, { team: "platform" });
});

// RL.3: getReleaseByVersion finds release
test("RL.3: getReleaseByVersion finds release", () => {
  platformKernel.createRelease({ version: "2.0.0-beta" });
  const found = platformKernel.getReleaseByVersion("2.0.0-beta");
  assert.ok(found);
  assert.strictEqual(found.version, "2.0.0-beta");
});

// RL.4: getReleaseByVersion returns null for missing
test("RL.4: getReleaseByVersion returns null for missing", () => {
  const found = platformKernel.getReleaseByVersion("99.0.0");
  assert.strictEqual(found, null);
});

// RL.5: publishRelease publishes draft
test("RL.5: publishRelease publishes draft", () => {
  const rel = platformKernel.createRelease({ version: "3.0.0" });
  const published = platformKernel.publishRelease(rel.release_id, { actor_id: "admin" });
  assert.strictEqual(published.state, "published");
  assert.ok(published.released_at);
});

// RL.6: listReleases lists all
test("RL.6: listReleases lists all", () => {
  platformKernel.createRelease({ version: "4.0.0" });
  platformKernel.createRelease({ version: "4.1.0" });
  const all = platformKernel.listReleases();
  assert.ok(all.length >= 2);
});

// RL.7: listReleases filters by state
test("RL.7: listReleases filters by state", () => {
  const rel = platformKernel.createRelease({ version: "5.0.0" });
  platformKernel.publishRelease(rel.release_id);
  const published = platformKernel.listReleases({ state: "published" });
  assert.ok(published.every(r => r.state === "published"));
});

// RL.8: release emits events
test("RL.8: release emits events", () => {
  const rel = platformKernel.createRelease({ version: "6.0.0" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'release.created' AND subject_id = ?").all(rel.release_id);
  assert.ok(events.length > 0);
});

// RL.9: publish emits event
test("RL.9: publish emits event", () => {
  const rel = platformKernel.createRelease({ version: "7.0.0" });
  platformKernel.publishRelease(rel.release_id);
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'release.published' AND subject_id = ?").all(rel.release_id);
  assert.ok(events.length > 0);
});

// RL.10: release with breaking changes
test("RL.10: release with breaking changes", () => {
  const rel = platformKernel.createRelease({ version: "8.0.0", breaking_changes: ["Removed deprecated auth endpoint", "Changed API response format"], deprecations: ["v1 API endpoints"] });
  const got = platformKernel.getRelease(rel.release_id);
  assert.strictEqual(got.breaking_changes.length, 2);
  assert.strictEqual(got.deprecations.length, 1);
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
