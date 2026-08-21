-- 039: Structured, versioned handoff resume packets.
--
-- The packet is deliberately stored with the handoff and its history. Existing
-- Existing content-only records remain readable; new callers attach structured resume packets.
-- state without creating a second source of truth.

ALTER TABLE memory_handoffs ADD COLUMN packet_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE memory_handoff_versions ADD COLUMN packet_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_memory_handoffs_status
  ON memory_handoffs(project, archived_at, packet_json);
