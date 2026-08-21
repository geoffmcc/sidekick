-- 053: Handoff v2 removes the pre-v2 KV handoff identity.
--
-- Existing handoff content and version history remain addressable by their
-- structured id. The old kv_key column is intentionally discarded so the
-- database schema cannot provide a second handoff identity or lookup path.

CREATE TABLE memory_handoffs_v2 (
  id TEXT PRIMARY KEY,
  project TEXT,
  title TEXT,
  source TEXT,
  task_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  previous_id TEXT,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  redacted_content TEXT NOT NULL,
  extraction_state TEXT NOT NULL DEFAULT 'pending',
  extraction_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  packet_json TEXT NOT NULL DEFAULT '{}',
  owner_principal_id TEXT,
  created_by_principal_id TEXT
);

INSERT INTO memory_handoffs_v2 (
  id, project, title, source, task_id, version, previous_id, content_hash,
  content, redacted_content, extraction_state, extraction_version, created_at,
  updated_at, archived_at, packet_json, owner_principal_id,
  created_by_principal_id
)
SELECT
  id, project, title, source, task_id, version, previous_id, content_hash,
  content, redacted_content, extraction_state, extraction_version, created_at,
  updated_at, archived_at, packet_json, owner_principal_id,
  created_by_principal_id
FROM memory_handoffs;

DROP TABLE memory_handoffs;
ALTER TABLE memory_handoffs_v2 RENAME TO memory_handoffs;

CREATE INDEX IF NOT EXISTS idx_memory_handoffs_project
  ON memory_handoffs(project, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_handoffs_hash
  ON memory_handoffs(content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_handoffs_status
  ON memory_handoffs(project, archived_at, packet_json);
CREATE INDEX IF NOT EXISTS idx_memory_handoffs_owner_principal
  ON memory_handoffs(owner_principal_id);
