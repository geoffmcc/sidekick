-- Governed, restart-safe retry recipes for effects that are proven absent.
-- Arguments are accepted only after the application rejects sensitive or
-- redacted values; this table is not a general argument/history store.
ALTER TABLE agent_operation_receipts ADD COLUMN retry_recipe_ref TEXT;
CREATE TABLE IF NOT EXISTS agent_retry_recipes (
  recipe_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
  capability TEXT NOT NULL, arguments_json TEXT NOT NULL DEFAULT '{}',
  target_ref TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  CHECK(length(arguments_json)<=12000)
);
CREATE INDEX IF NOT EXISTS idx_agent_retry_recipes_task ON agent_retry_recipes(task_id, created_at);
INSERT OR REPLACE INTO meta (key,value) VALUES ('agent_task_schema_version','6');
