-- Persist only the bounded, non-secret principal constraints needed to
-- re-evaluate authority after restart. Credential material never belongs here.
ALTER TABLE agent_tasks ADD COLUMN principal_context_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_agent_tasks_principal_context
  ON agent_tasks(actor_principal_id, requested_by_principal_id);
INSERT OR REPLACE INTO meta (key,value) VALUES ('agent_task_schema_version','7');
