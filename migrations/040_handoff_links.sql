-- First-class append-only lineage for structured handoff packet entries.
CREATE TABLE IF NOT EXISTS memory_handoff_links (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN ('evidence', 'artifact', 'relationship')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(handoff_id, version, link_type, id)
);

CREATE INDEX IF NOT EXISTS idx_handoff_links_handoff_version
  ON memory_handoff_links(handoff_id, version, link_type);
