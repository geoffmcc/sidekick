-- Evidence-driven Evolve lifecycle and dynamic generated tools.

-- Telemetry columns are added idempotently by src/db.js because SQLite does not
-- support ALTER TABLE ADD COLUMN IF NOT EXISTS on all supported versions.

CREATE INDEX IF NOT EXISTS idx_tool_logs_session_task ON tool_logs(source, session_id, task_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_logs_fingerprint ON tool_logs(tool_name, arg_fingerprint);

CREATE TABLE IF NOT EXISTS generated_capabilities (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL,
  title TEXT,
  description TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  schema_json TEXT,
  parameters_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'medium',
  validation_json TEXT,
  approver TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  activation_date TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  estimated_calls_saved INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  user_feedback_json TEXT NOT NULL DEFAULT '[]',
  usefulness_score INTEGER NOT NULL DEFAULT 0,
  deprecation_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generated_capabilities_state ON generated_capabilities(state);
CREATE INDEX IF NOT EXISTS idx_generated_capabilities_name ON generated_capabilities(name);

CREATE TABLE IF NOT EXISTS generated_tool_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  invoked_at TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  args_summary TEXT,
  result_summary TEXT,
  FOREIGN KEY(capability_id) REFERENCES generated_capabilities(id)
);

CREATE INDEX IF NOT EXISTS idx_generated_tool_audit_capability ON generated_tool_audit(capability_id, invoked_at DESC);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7');
