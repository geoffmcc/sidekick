-- Durable fields used by execution-node cancellation and the approval runner.
ALTER TABLE execution_node_jobs ADD COLUMN cancellation_requested INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS approval_runtime_meta (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
