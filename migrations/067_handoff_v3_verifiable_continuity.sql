-- 067: Handoff v3 verifiable continuity.
-- Existing packet content remains authoritative for legacy records; these fields
-- add durable lifecycle, checkpoint, claim, and journal state without inventing
-- evidence for historical handoffs.

ALTER TABLE memory_handoffs ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 2;
ALTER TABLE memory_handoffs ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'draft'
  CHECK (lifecycle_state IN ('draft', 'ready', 'claimed', 'verifying', 'reconciliation_required', 'active', 'released', 'superseded', 'revoked', 'completed', 'expired', 'invalid'));
ALTER TABLE memory_handoffs ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE memory_handoffs ADD COLUMN checkpoint_hash TEXT;
ALTER TABLE memory_handoffs ADD COLUMN claim_owner TEXT;
ALTER TABLE memory_handoffs ADD COLUMN claim_token TEXT;
ALTER TABLE memory_handoffs ADD COLUMN claim_expires_at TEXT;
ALTER TABLE memory_handoffs ADD COLUMN sealed_at TEXT;
ALTER TABLE memory_handoffs ADD COLUMN revoked_at TEXT;
ALTER TABLE memory_handoffs ADD COLUMN superseded_by TEXT;
ALTER TABLE memory_handoffs ADD COLUMN completed_at TEXT;

CREATE TABLE IF NOT EXISTS memory_handoff_events (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  source TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(handoff_id, event_seq),
  UNIQUE(handoff_id, event_hash)
);

CREATE INDEX IF NOT EXISTS idx_handoff_events_handoff_time
  ON memory_handoff_events(handoff_id, event_seq DESC);
CREATE INDEX IF NOT EXISTS idx_handoffs_lifecycle
  ON memory_handoffs(project, lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoffs_claim_expiry
  ON memory_handoffs(claim_expires_at);
