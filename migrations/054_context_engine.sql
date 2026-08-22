-- Context Engine receipts and explicitly promoted consolidation candidates.
-- Candidates are evidence-backed proposals; they are never durable memory until
-- an explicit confirmation promotes them through the existing memory writer.

CREATE TABLE IF NOT EXISTS context_receipts (
  id TEXT PRIMARY KEY,
  query_digest TEXT NOT NULL,
  project TEXT,
  principal_id TEXT,
  session_id TEXT,
  task_id TEXT,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_receipts_scope
  ON context_receipts(project, principal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_consolidation_candidates (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_memory_ids_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  validation_status TEXT NOT NULL DEFAULT 'unvalidated',
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  promoted_memory_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_consolidation_candidate_fingerprint
  ON memory_consolidation_candidates(project, fingerprint);
CREATE INDEX IF NOT EXISTS idx_consolidation_candidate_status
  ON memory_consolidation_candidates(project, status, updated_at DESC);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '54');
