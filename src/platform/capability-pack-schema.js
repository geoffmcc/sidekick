"use strict";

// Platform-owned capability-pack schema. Keeping this beside the kernel avoids
// a platform -> pack implementation dependency; packs/schema.js remains a
// compatibility export for callers that used the old location.
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
  if (ensured) return;
  require("../db").getDb().exec(PACK_SCHEMA_SQL);
  ensured = true;
}

module.exports = { PACK_SCHEMA_SQL, ensureCapabilityPackSchema };
