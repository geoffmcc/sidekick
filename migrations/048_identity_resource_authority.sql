-- Durable ownership and execution identity for governed resources.
ALTER TABLE platform_runner_sessions ADD COLUMN requested_by_principal_id TEXT;
ALTER TABLE platform_runner_sessions ADD COLUMN actor_principal_id TEXT;
ALTER TABLE platform_runner_sessions ADD COLUMN acting_for_principal_id TEXT;
ALTER TABLE platform_runner_sessions ADD COLUMN executed_by_principal_id TEXT;
ALTER TABLE platform_artifacts ADD COLUMN owner_principal_id TEXT;
ALTER TABLE platform_artifacts ADD COLUMN created_by_principal_id TEXT;
ALTER TABLE memory_handoffs ADD COLUMN owner_principal_id TEXT;
ALTER TABLE memory_handoffs ADD COLUMN created_by_principal_id TEXT;
ALTER TABLE memory_task_sessions ADD COLUMN owner_principal_id TEXT;
ALTER TABLE memory_task_sessions ADD COLUMN created_by_principal_id TEXT;
CREATE INDEX IF NOT EXISTS idx_platform_runner_sessions_actor_principal ON platform_runner_sessions(actor_principal_id);
CREATE INDEX IF NOT EXISTS idx_platform_artifacts_owner_principal ON platform_artifacts(owner_principal_id);
CREATE INDEX IF NOT EXISTS idx_memory_handoffs_owner_principal ON memory_handoffs(owner_principal_id);
CREATE INDEX IF NOT EXISTS idx_memory_task_sessions_owner_principal ON memory_task_sessions(owner_principal_id);
