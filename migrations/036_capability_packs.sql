-- Capability Packs v1 + B9 third-party module lifecycle storage.
--
-- Additive. Three concerns land together because they are one product slice:
--   1. platform_modules gains the managed-installation columns B9 needs
--      (managed package location, whole-package integrity hash, provenance).
--   2. platform_capability_packs / platform_capability_pack_components record
--      installable areas of competence and the components each pack owns.
--   3. platform_workflow_definitions gives Sidekick a durable workflow
--      DEFINITION registry to sit in front of the existing platform_workflows
--      execution tables, so packs can contribute runnable workflows without a
--      second workflow engine.
--
-- Must stay byte-identical (up to whitespace) to the runtime ensure paths in
-- src/modules/schema.js, src/packs/schema.js and src/workflows/schema.js —
-- see test/kernel-migration-parity.test.js. Column ORDER matters: the runtime
-- path reaches the same sqlite_master DDL by applying the same ALTERs in the
-- same order.

ALTER TABLE platform_modules ADD COLUMN install_path TEXT;
ALTER TABLE platform_modules ADD COLUMN package_hash TEXT;
ALTER TABLE platform_modules ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';

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

CREATE TABLE IF NOT EXISTS platform_workflow_definitions (
  definition_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  title TEXT,
  description TEXT,
  owner_kind TEXT NOT NULL DEFAULT 'core',
  owner_name TEXT,
  state TEXT NOT NULL DEFAULT 'registered',
  mode TEXT NOT NULL DEFAULT 'read_only',
  definition_json TEXT NOT NULL DEFAULT '{}',
  checksum TEXT,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_workflow_definitions_name ON platform_workflow_definitions(name);
CREATE INDEX IF NOT EXISTS idx_platform_workflow_definitions_owner ON platform_workflow_definitions(owner_kind, owner_name);
CREATE INDEX IF NOT EXISTS idx_platform_workflow_definitions_state ON platform_workflow_definitions(state, name);

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '10');
