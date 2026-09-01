-- Knowledge full-text search schema.
--
-- The runtime repair remains responsible for refreshing rows, but the
-- migration history owns the virtual table shape and its version marker. This
-- keeps migrations-only and runtime-first boots on the same search schema.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  category, title, content, tags, version_added, updated_at
);

INSERT OR REPLACE INTO meta (key, value)
VALUES ('knowledge_fts_schema_version', '1');
