"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const previousDataDir = process.env.SIDEKICK_DATA_DIR;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-module-migration-security-"));
process.env.SIDEKICK_DATA_DIR = testDataDir;

const { runModuleMigrations } = require("../src/modules/migrations");
const dbStore = require("../src/db");
const repository = require("../src/modules/repository");

dbStore.runPendingMigrations();
after(() => {
  dbStore.closeDatabase();
  if (previousDataDir === undefined) delete process.env.SIDEKICK_DATA_DIR;
  else process.env.SIDEKICK_DATA_DIR = previousDataDir;
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

class RecordingDb {
  constructor() { this.statements = []; }
  exec(sql) { this.statements.push(sql); }
}

test("managed module SQL cannot execute against Core even when identifier quoting evades lexical checks", () => {
  const db = new RecordingDb();
  const hostileSql = "UPDATE [principals] SET enabled = 0";

  assert.throws(() => runModuleMigrations(db, "hostile-fixture", [
    { name: "001-disable-principals", sql: hostileSql },
  ]), /disabled for non-builtin modules/);
  assert.deepEqual(db.statements, [], "denial must precede BEGIN or any Core database operation");
});

test("previously applied migration text is never re-executed", () => {
  const db = new RecordingDb();
  const result = runModuleMigrations(db, "hostile-fixture", [
    { name: "001-old", sql: "UPDATE [principals] SET enabled = 0" },
  ], ["001-old"]);

  assert.deepEqual(result.applied, []);
  assert.deepEqual(db.statements, []);
});

test("Core database migration authority is derived from the persisted builtin source", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "repository.js"), "utf8");
  assert.match(source, /trustedBuiltin:\s*record\.source\s*===\s*["']builtin["']/);
});

test("repository denies a managed bracket-quoted principal mutation before it reaches SQLite", () => {
  const db = dbStore.getDb();
  db.prepare(`INSERT INTO principals (principal_id, principal_type, display_name, enabled, metadata_json, created_at, updated_at)
    VALUES (?, 'service', ?, 1, '{}', ?, ?)`).run("principal_migration_fixture", "migration fixture", "2026-10-19T00:00:00.000Z", "2026-10-19T00:00:00.000Z");

  repository.registerModule({
    name: "hostile-migration-fixture",
    version: "1.0.0",
    description: "Disposable module migration security fixture",
    migrations: [{ name: "disable-principals", sql: "UPDATE [principals] SET enabled = 0" }],
  }, { source: "installed" });

  assert.throws(
    () => repository.applyModuleMigrations("hostile-migration-fixture"),
    /disabled for non-builtin modules/
  );
  const principal = db.prepare("SELECT enabled FROM principals WHERE principal_id = ?").get("principal_migration_fixture");
  assert.equal(principal.enabled, 1);
  assert.deepEqual(repository.getModule("hostile-migration-fixture").applied_migrations, []);
});
