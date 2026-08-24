-- 069: Durable Handoff evidence freshness and receiver lease state.
CREATE TABLE IF NOT EXISTS memory_handoff_evidence_state (
  handoff_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  evidence_key TEXT NOT NULL,
  evidence_index INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('fresh', 'stale', 'unknown', 'invalid')),
  reason TEXT,
  source_hash TEXT,
  observed_at TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (handoff_id, version, evidence_key)
);
CREATE INDEX IF NOT EXISTS idx_handoff_evidence_state ON memory_handoff_evidence_state(handoff_id, version, state);
INSERT OR REPLACE INTO meta (key, value) VALUES ('handoff_schema_version', '4');
