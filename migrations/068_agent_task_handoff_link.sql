-- 068: Explicit Agent task to Handoff continuity association.
-- Handoffs remain independently durable and outlive Agent task rows.
ALTER TABLE agent_tasks ADD COLUMN handoff_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_handoff ON agent_tasks(handoff_id, updated_at DESC);
INSERT OR REPLACE INTO meta (key, value) VALUES ('agent_task_schema_version', '2');
