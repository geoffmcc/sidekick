#!/usr/bin/env node
/**
 * Seed the Sidekick knowledge table from docs/knowledge-seed.sql.
 *
 * Default behavior is conservative: seed only when the knowledge table has no
 * enabled rows. Use --force to add or re-apply only the seed marker rows.
 */

const fs = require("fs");
const path = require("path");

require("../src/env");
const dbStore = require("../src/db");

const force = process.argv.includes("--force");
const repoRoot = path.join(__dirname, "..");
const seedPath = path.join(repoRoot, "docs", "knowledge-seed.sql");

function main() {
  if (!fs.existsSync(seedPath)) {
    throw new Error(`Knowledge seed not found: ${seedPath}`);
  }

  const migrations = dbStore.runPendingMigrations();
  if (migrations.applied > 0) {
    console.log(`[KnowledgeSeed] Applied ${migrations.applied} migration(s) before seeding`);
  }

  const db = dbStore.getDb();
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge'").get();
  if (!table) {
    throw new Error("knowledge table does not exist after migrations");
  }

  const count = db.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE enabled = 1").get().count;
  if (count > 0 && !force) {
    console.log(`[KnowledgeSeed] Skipped: knowledge table already has ${count} enabled entr${count === 1 ? "y" : "ies"}`);
    return;
  }

  const sql = fs.readFileSync(seedPath, "utf8");
  db.exec(sql);

  const seeded = db.prepare(
    "SELECT COUNT(*) AS count FROM knowledge WHERE version_added = ? AND enabled = 1"
  ).get("seed-2026-06-16-current").count;

  console.log(`[KnowledgeSeed] Imported ${seeded} seeded knowledge entries`);
}

try {
  main();
} catch (error) {
  console.error(`[KnowledgeSeed] Error: ${error.message}`);
  process.exit(1);
}
