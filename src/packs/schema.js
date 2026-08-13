"use strict";

// Capability-pack lifecycle schema (docs/capability-packs.md).
//
// Must stay byte-identical (up to whitespace) to the capability-pack section
// of migrations/036_capability_packs.sql. The runtime ensures this schema
// idempotently so every process that touches packs converges, even when
// migrations are not run (kernel boot path) — the same contract the module
// subsystem uses.
//
// A pack row is durable IDENTITY, LIFECYCLE and OWNERSHIP only. Module runtime
// state stays on platform_modules, workflow definitions on
// platform_workflow_definitions, execution history in the kernel ledger, and
// knowledge in the knowledge store. The components table records which pack
// owns which component so disable/upgrade/uninstall can act coherently without
// becoming a competing source of truth.

const PACK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS platform_capability_packs (
  pack_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  version TEXT NOT NULL,
  description TEXT,
  publisher TEXT,
  provenance TEXT NOT NULL DEFAULT 'third_party',
  state TEXT NOT NULL DEFAULT 'installed',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  package_hash TEXT,
  install_path TEXT,
  source_json TEXT NOT NULL DEFAULT '{}',
  compatibility TEXT,
  health_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  installed_at TEXT NOT NULL,
  configured_at TEXT,
  enabled_at TEXT,
  disabled_at TEXT,
  last_health_check_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_capability_packs_name ON platform_capability_packs(name);
CREATE INDEX IF NOT EXISTS idx_platform_capability_packs_state ON platform_capability_packs(state, installed_at DESC);

CREATE TABLE IF NOT EXISTS platform_capability_pack_components (
  component_id TEXT PRIMARY KEY,
  pack_name TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  version TEXT,
  state TEXT NOT NULL DEFAULT 'installed',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_pack_components_unique ON platform_capability_pack_components(pack_name, kind, ref);
CREATE INDEX IF NOT EXISTS idx_platform_pack_components_kind ON platform_capability_pack_components(kind, ref);
`;

let ensured = false;

function ensureCapabilityPackSchema() {
  // Memoized for the same reason as the module schema: this sits on the
  // per-dispatch gate for pack tools, and the schema cannot un-exist within a
  // process lifetime. A re-required module (tests) resets the flag.
  if (ensured) return;
  require("../db").getDb().exec(PACK_SCHEMA_SQL);
  ensured = true;
}

module.exports = { PACK_SCHEMA_SQL, ensureCapabilityPackSchema };
