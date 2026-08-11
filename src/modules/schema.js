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

let ensured = false;

function ensurePlatformModuleSchema() {
  // Memoized: this now sits on the per-dispatch gate for module tools, and
  // the schema cannot un-exist within a process lifetime. A re-required
  // module (tests) resets the flag with the module instance.
  if (ensured) return;
  const db = require("../db").getDb();
  db.exec(MODULE_SCHEMA_SQL);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'platform_module_schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('platform_module_schema_version', '1')").run();
  }
  ensured = true;
}

module.exports = { MODULE_SCHEMA_SQL, ensurePlatformModuleSchema };
