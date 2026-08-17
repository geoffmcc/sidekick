-- Track how durable knowledge was promoted so generated or taught content
-- remains attributable and reviewable after it enters the knowledge store.
ALTER TABLE knowledge ADD COLUMN source_type TEXT;
ALTER TABLE knowledge ADD COLUMN source_id TEXT;
ALTER TABLE knowledge ADD COLUMN source_version TEXT;
ALTER TABLE knowledge ADD COLUMN provenance_json TEXT;
ALTER TABLE knowledge ADD COLUMN approved_by TEXT;
ALTER TABLE knowledge ADD COLUMN approved_at TEXT;

CREATE INDEX IF NOT EXISTS idx_knowledge_source
  ON knowledge(source_type, source_id, source_version);
