"use strict";

// Platform module lifecycle schema (docs/module-system-design.md).
//
// Must stay byte-identical (up to whitespace) to migrations/029_platform_modules.sql.
// The runtime ensures this schema idempotently so every process that touches
// modules converges, even when migrations are not run (kernel boot path).

const MODULE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS platform_modules (
  module_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'plugin',
  author TEXT,
  description TEXT,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  migration_version INTEGER NOT NULL DEFAULT 0,
  applied_migrations_json TEXT NOT NULL DEFAULT '[]',
  health_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'discovered',
  entry_point TEXT,
  registered_at TEXT NOT NULL,
  installed_at TEXT,
  configured_at TEXT,
  enabled_at TEXT,
  disabled_at TEXT,
  uninstalled_at TEXT,
  last_health_check_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_modules_name ON platform_modules(name);
CREATE INDEX IF NOT EXISTS idx_platform_modules_state ON platform_modules(state, registered_at DESC);
`;

// Columns added after the original 029 CREATE. Order is part of the contract:
// SQLite appends each ADD COLUMN to the stored CREATE text, so both boot paths
// must apply them identically.
//   entry_hash    — 029 (inline in the migration, ALTER here)
//   install_path  — 036, managed installation directory for third-party packages
//   package_hash  — 036, whole-package integrity hash of the managed installation
//   provenance_json — 036, where the package came from and who installed it
const ADDITIVE_MODULE_COLUMNS = Object.freeze([
  ["entry_hash", "entry_hash TEXT"],
  ["install_path", "install_path TEXT"],
  ["package_hash", "package_hash TEXT"],
  ["provenance_json", "provenance_json TEXT NOT NULL DEFAULT '{}'"],
]);

let ensured = false;

function ensurePlatformModuleSchema() {
  // Memoized: this now sits on the per-dispatch gate for module tools, and
  // the schema cannot un-exist within a process lifetime. A re-required
  // module (tests) resets the flag with the module instance.
  if (ensured) return;
  const db = require("../db").getDb();
  db.exec(MODULE_SCHEMA_SQL);
  const columns = db.prepare("PRAGMA table_info(platform_modules)").all();
  const present = new Set(columns.map(column => column.name));
  // Additive columns, applied in the SAME ORDER as migrations/029 + 036 so the
  // migrations-only boot and this runtime boot reach identical sqlite_master
  // DDL (test/kernel-migration-parity.test.js).
  for (const [column, ddl] of ADDITIVE_MODULE_COLUMNS) {
    if (!present.has(column)) db.exec(`ALTER TABLE platform_modules ADD COLUMN ${ddl}`);
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'platform_module_schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('platform_module_schema_version', '1')").run();
  }
  ensured = true;
}

module.exports = { MODULE_SCHEMA_SQL, ensurePlatformModuleSchema };
