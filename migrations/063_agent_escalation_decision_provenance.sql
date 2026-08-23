-- Durable, redacted provenance for non-executable escalation dispositions.
-- approval_ref points only to an existing governed approval record; it never
-- authorizes a replacement operation or transfers approval to a child task.
ALTER TABLE agent_escalation_packages ADD COLUMN approval_ref TEXT;
ALTER TABLE agent_escalation_packages ADD COLUMN decided_by_principal_id TEXT;
ALTER TABLE agent_escalation_packages ADD COLUMN decision_at TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_escalations_decision ON agent_escalation_packages(decided_by_principal_id, decision_at);
INSERT OR REPLACE INTO meta (key,value) VALUES ('agent_task_schema_version','8');
