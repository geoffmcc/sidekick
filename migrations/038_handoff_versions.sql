-- 038: Handoff version history.
--
-- memory_handoffs always carried `version` and `previous_id` columns, but the
-- save path never produced a working chain: id-based updates overwrote the row
-- in place at version 1, and key-based updates violated the kv_key UNIQUE
-- constraint. This migration adds the append-only history table that makes
-- versioning real: the memory_handoffs row is always the LATEST version of a
-- handoff, and every superseded version is preserved here verbatim.
--
-- History rows are written by src/db.js saveHandoff at the moment a content
-- change supersedes the current row, and by restoreHandoffVersion (a restore
-- appends the restored content as a NEW latest version; history is never
-- deleted or rewritten).

CREATE TABLE IF NOT EXISTS memory_handoff_versions (
  handoff_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT,
  project TEXT,
  source TEXT,
  task_id TEXT,
  content TEXT NOT NULL,
  redacted_content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (handoff_id, version)
);

CREATE INDEX IF NOT EXISTS idx_memory_handoff_versions_handoff
  ON memory_handoff_versions(handoff_id, version DESC);
