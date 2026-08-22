-- Additive durable continuation ledger for Agent safe-boundary recovery.
-- Raw tool output is never stored here; only bounded fingerprints, receipts,
-- and redacted summaries are retained.
ALTER TABLE agent_tasks ADD COLUMN control_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN continuation_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN artifact_refs_json TEXT NOT NULL DEFAULT '[]';
INSERT OR REPLACE INTO meta (key, value) VALUES ('agent_task_schema_version', '2');
