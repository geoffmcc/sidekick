-- Migration 026: Platform kernel table parity.
-- Migration 011 established the four base kernel tables. The runtime kernel
-- schema (src/platform/kernel-schema.js) additionally maintains ten more
-- tables. Add them here so a database bootstrapped purely from migrations
-- converges with one bootstrapped by the runtime kernel, without dropping or
-- renaming existing objects. Keep this file in sync with kernel-schema.js;
-- test/kernel-migration-parity.test.js enforces the two boot paths match.

CREATE TABLE IF NOT EXISTS platform_capabilities (
  capability_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  project_id TEXT,
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_capabilities_actor ON platform_capabilities(actor_id, capability, project_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_platform_capabilities_actor_scan ON platform_capabilities(actor_id, revoked_at);

CREATE TABLE IF NOT EXISTS platform_change_sets (
  change_set_id TEXT PRIMARY KEY,
  execution_id TEXT,
  approval_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_action TEXT,
  operation_type TEXT NOT NULL,
  state TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  previous_hash TEXT,
  actor_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  args_snapshot_json TEXT NOT NULL DEFAULT '{}',
  result_summary TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_platform_change_sets_approval ON platform_change_sets(approval_id, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_change_sets_execution ON platform_change_sets(execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_change_sets_hash ON platform_change_sets(content_hash);

CREATE TABLE IF NOT EXISTS platform_workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'defined',
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  execution_id TEXT,
  project_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_platform_workflows_state ON platform_workflows(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_workflows_project ON platform_workflows(project_id, state);

CREATE TABLE IF NOT EXISTS platform_workflow_steps (
  step_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  tool_name TEXT,
  tool_action TEXT,
  args_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  result_summary TEXT,
  error_category TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  execution_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_workflow_steps_idx ON platform_workflow_steps(workflow_id, step_index);
CREATE INDEX IF NOT EXISTS idx_platform_workflow_steps_state ON platform_workflow_steps(state, workflow_id);

CREATE TABLE IF NOT EXISTS platform_runner_sessions (
  runner_id TEXT PRIMARY KEY,
  execution_id TEXT,
  workflow_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  resource_limits_json TEXT NOT NULL DEFAULT '{}',
  resource_usage_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  heartbeat_at TEXT,
  completed_at TEXT,
  terminated_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_platform_runner_sessions_state ON platform_runner_sessions(state, started_at DESC);

CREATE TABLE IF NOT EXISTS platform_project_workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  config_json TEXT NOT NULL DEFAULT '{}',
  secrets_json TEXT NOT NULL DEFAULT '{}',
  environment TEXT,
  resource_limits_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_workspaces_project ON platform_project_workspaces(project_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_platform_workspaces_owner ON platform_project_workspaces(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_platform_workspaces_state ON platform_project_workspaces(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_model_registry (
  model_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  version TEXT,
  state TEXT NOT NULL DEFAULT 'registered',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  context_window INTEGER,
  max_output_tokens INTEGER,
  supports_streaming INTEGER NOT NULL DEFAULT 0,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_tools INTEGER NOT NULL DEFAULT 1,
  cost_per_1k_input REAL,
  cost_per_1k_output REAL,
  rate_limit_rpm INTEGER,
  registered_by TEXT,
  registered_at TEXT NOT NULL,
  deprecated_at TEXT,
  last_used_at TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_model_name_provider ON platform_model_registry(name, provider);
CREATE INDEX IF NOT EXISTS idx_platform_model_state ON platform_model_registry(state, registered_at DESC);

CREATE TABLE IF NOT EXISTS platform_extensions (
  extension_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'registered',
  type TEXT NOT NULL DEFAULT 'plugin',
  author TEXT,
  description TEXT,
  entry_point TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  config_schema_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  hooks_json TEXT NOT NULL DEFAULT '[]',
  registered_at TEXT NOT NULL,
  activated_at TEXT,
  deactivated_at TEXT,
  uninstalled_at TEXT,
  last_used_at TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_extension_name ON platform_extensions(name);
CREATE INDEX IF NOT EXISTS idx_platform_extension_state ON platform_extensions(state, registered_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_extension_type ON platform_extensions(type, state);

CREATE TABLE IF NOT EXISTS platform_releases (
  release_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  codename TEXT,
  description TEXT,
  changelog_json TEXT NOT NULL DEFAULT '[]',
  migration_version INTEGER,
  breaking_changes_json TEXT NOT NULL DEFAULT '[]',
  deprecations_json TEXT NOT NULL DEFAULT '[]',
  upgrade_notes TEXT,
  released_by TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_release_version ON platform_releases(version);
CREATE INDEX IF NOT EXISTS idx_platform_release_state ON platform_releases(state, released_at DESC);

CREATE TABLE IF NOT EXISTS platform_backups (
  backup_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'created',
  type TEXT NOT NULL DEFAULT 'full',
  tables_included_json TEXT NOT NULL DEFAULT '[]',
  row_counts_json TEXT NOT NULL DEFAULT '{}',
  file_path TEXT,
  file_size_bytes INTEGER,
  checksum TEXT,
  compression TEXT DEFAULT 'none',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  restored_at TEXT,
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_platform_backup_state ON platform_backups(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_backup_type ON platform_backups(type, state);

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '1');
