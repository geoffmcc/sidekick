-- Structured Memory Schema
-- First-class memory rows for automatic recall, deduplication, and future review UI.

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  tags TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT,
  source_tool TEXT,
  source_task_id TEXT,
  source_ref TEXT,
  metadata_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  automatic INTEGER NOT NULL DEFAULT 1,
  times_confirmed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_enabled ON memories(enabled);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source_task ON memories(source_task_id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');
