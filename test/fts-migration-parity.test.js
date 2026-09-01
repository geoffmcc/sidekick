"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { splitSqlStatements } = require("../src/core/sql-statements");

const migrationsDir = path.join(__dirname, "..", "migrations");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-fts-parity-"));
const migrationOnlyDb = new Database(":memory:");

function migrationFiles() {
  return fs.readdirSync(migrationsDir).filter(file => /^\d{3}_.*\.sql$/.test(file)).sort();
}

try {
  // This deliberately bypasses src/db.js to prove the migration itself owns
  // the FTS object, not merely the runtime bootstrap.
  for (const file of migrationFiles()) {
    for (const statement of splitSqlStatements(fs.readFileSync(path.join(migrationsDir, file), "utf8"))) {
      migrationOnlyDb.exec(statement);
    }
  }
  assert.ok(migrationOnlyDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'knowledge_fts'").get());
  assert.strictEqual(
    migrationOnlyDb.prepare("SELECT value FROM meta WHERE key = 'knowledge_fts_schema_version'").get().value,
    "1",
    "migration-only boot must record the FTS schema version"
  );

  process.env.SIDEKICK_DATA_DIR = dataDir;
  process.env.SIDEKICK_DB_FILE = path.join(dataDir, "runtime.sqlite");
  delete require.cache[require.resolve("../src/db")];
  const dbStore = require("../src/db");
  dbStore.runPendingMigrations();
  const db = dbStore.getDb();
  const row = db.prepare("INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").run(
    "certification", "FTS convergence", "migration-owned search schema", "runtime", new Date().toISOString(), new Date().toISOString()
  );
  db.prepare("DELETE FROM knowledge_fts WHERE rowid = ?").run(row.lastInsertRowid);
  const repaired = dbStore.rebuildKnowledgeFts();
  assert.strictEqual(repaired.success, true);
  assert.ok(db.prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH 'convergence'").get());
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'knowledge_fts_schema_version'").get().value, "1");
  console.log("Knowledge FTS migration parity tests passed.");
} finally {
  migrationOnlyDb.close();
  try { require("../src/db").closeDatabase(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
}
