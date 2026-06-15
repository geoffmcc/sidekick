-- Initial schema baseline
-- This represents the current database schema as of v1

-- Meta table for schema versioning
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Key-value store with project/source metadata
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  project TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Named JSON documents
CREATE TABLE IF NOT EXISTS json_documents (
  name TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tool execution logs
CREATE TABLE IF NOT EXISTS tool_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_summary TEXT,
  duration_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  source TEXT,
  entry_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_logs_timestamp ON tool_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tool_logs_tool_name ON tool_logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_logs_success ON tool_logs(success);
