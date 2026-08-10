-- Migration 027: Platform canonical project projection, cross-source identity,
-- and encrypted workspace secret references.
--
-- Phase 3 of the platform convergence track. Introduces the canonical project
-- registry (platform_projects), the cross-source identity mapping table
-- (platform_project_sources), and the encrypted workspace secret store
-- (platform_workspace_secrets). Workspace secrets move from the legacy
-- plaintext secrets_json column into per-secret ciphertext envelopes keyed by
-- SIDEKICK_SECRET_KEY, without dropping or renaming existing columns.
--
-- All objects are created with CREATE TABLE IF NOT EXISTS so the migration is
-- idempotent regardless of whether the runtime kernel schema (which declares
-- the same DDL in src/platform/kernel-schema.js) ran first. Both boot paths
-- must produce byte-identical sqlite_master text;
-- test/kernel-migration-parity.test.js enforces it.

CREATE TABLE IF NOT EXISTS platform_projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  owner_actor_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_platform_projects_state ON platform_projects(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_project_sources (
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id, source, source_id),
  FOREIGN KEY(project_id) REFERENCES platform_projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_project_sources_project ON platform_project_sources(project_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_project_sources_source ON platform_project_sources(source, source_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS platform_workspace_secrets (
  workspace_id TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, secret_name),
  FOREIGN KEY(workspace_id) REFERENCES platform_project_workspaces(workspace_id)
);

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '2');
