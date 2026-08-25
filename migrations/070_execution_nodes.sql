-- General governed execution nodes. Runtime schema creation remains defensive
-- for standalone node/controller tests; this ordered migration is the durable
-- production schema authority.
CREATE TABLE IF NOT EXISTS execution_nodes (
  worker_id TEXT PRIMARY KEY REFERENCES compute_workers(worker_id) ON DELETE CASCADE,
  protocol_version TEXT NOT NULL DEFAULT '1',
  descriptor_set_hash TEXT NOT NULL DEFAULT '',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  authorized_workspaces_json TEXT NOT NULL DEFAULT '[]',
  authorized_network_scopes_json TEXT NOT NULL DEFAULT '[]',
  local_limits_json TEXT NOT NULL DEFAULT '{}',
  capability_state TEXT NOT NULL DEFAULT 'unknown',
  capability_checked_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_execution_nodes_capability_state ON execution_nodes(capability_state);

CREATE TABLE IF NOT EXISTS execution_node_workspaces (
  workspace_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES compute_workers(worker_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  root_identity TEXT NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  limits_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'active',
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(worker_id, name)
);
CREATE INDEX IF NOT EXISTS idx_execution_node_workspaces_worker ON execution_node_workspaces(worker_id);

CREATE TABLE IF NOT EXISTS execution_node_repositories (
  repository_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES execution_node_workspaces(workspace_id) ON DELETE CASCADE,
  root_identity TEXT NOT NULL,
  display_name TEXT,
  state TEXT NOT NULL DEFAULT 'registered',
  last_seen_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(workspace_id, root_identity)
);

CREATE TABLE IF NOT EXISTS execution_node_jobs (
  job_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES compute_workers(worker_id),
  task_id TEXT,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  descriptor_version TEXT NOT NULL,
  descriptor_identity TEXT NOT NULL,
  args_json TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  workspace_id TEXT,
  repository_id TEXT,
  idempotency_key TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'queued',
  lease_id TEXT,
  lease_expires_at TEXT,
  result_json TEXT,
  receipt_json TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_execution_node_jobs_worker_state ON execution_node_jobs(worker_id, state);
CREATE INDEX IF NOT EXISTS idx_execution_node_jobs_lease ON execution_node_jobs(lease_expires_at);
