-- Persistent execution observability for generated trial/active tools.

CREATE TABLE IF NOT EXISTS generated_tool_executions (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL,
  source TEXT,
  args_json TEXT NOT NULL DEFAULT '{}',
  success_criteria TEXT,
  success_criteria_satisfied INTEGER,
  final_summary TEXT,
  error_category TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(capability_id) REFERENCES generated_capabilities(id)
);

CREATE INDEX IF NOT EXISTS idx_generated_tool_executions_capability ON generated_tool_executions(capability_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_tool_executions_state ON generated_tool_executions(state);

CREATE TABLE IF NOT EXISTS generated_tool_execution_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  result_summary TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  success INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(execution_id) REFERENCES generated_tool_executions(id)
);

CREATE INDEX IF NOT EXISTS idx_generated_tool_execution_steps_execution ON generated_tool_execution_steps(execution_id, step_number);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8');
