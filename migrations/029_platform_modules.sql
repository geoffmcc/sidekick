-- Platform module lifecycle storage (docs/module-system-design.md).
--
-- The module loader owns module behavior; this table persists module lifecycle
-- state, manifest, configuration, migration progress and health so an enabled
-- module survives restarts. It is additive and must stay byte-identical to
-- MODULE_SCHEMA_SQL in src/modules/schema.js (see kernel-migration-parity test).

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
