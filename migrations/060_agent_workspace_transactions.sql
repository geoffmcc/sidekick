-- Durable transactional workspace records. These records describe governed
-- resources and evidence; they never store raw commands or secret-bearing args.
CREATE TABLE IF NOT EXISTS agent_workspace_transactions (
  transaction_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  receipt_id TEXT,
  workspace_ref TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  affected_resources_json TEXT NOT NULL DEFAULT '[]',
  pre_state_json TEXT NOT NULL DEFAULT '{}',
  mutation_capability TEXT NOT NULL,
  mutation_args_digest TEXT NOT NULL,
  post_state_json TEXT NOT NULL DEFAULT '{}',
  rollback_capability TEXT,
  rollback_recipe_ref TEXT,
  rollback_args_json TEXT NOT NULL DEFAULT '{}',
  rollback_state TEXT NOT NULL DEFAULT 'unavailable',
  state TEXT NOT NULL DEFAULT 'prepared',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY(receipt_id) REFERENCES agent_operation_receipts(receipt_id) ON DELETE SET NULL,
  CHECK(length(affected_resources_json)<=30000),
  CHECK(length(pre_state_json)<=30000),
  CHECK(length(post_state_json)<=30000)
  ,CHECK(length(rollback_args_json)<=12000)
);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_transactions_task_state
  ON agent_workspace_transactions(task_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_transactions_receipt
  ON agent_workspace_transactions(receipt_id);
INSERT OR REPLACE INTO meta (key,value) VALUES ('agent_task_schema_version','5');
