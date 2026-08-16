-- Durable identity for workflow runs and their execution ledger rows.
ALTER TABLE platform_executions ADD COLUMN requested_by_principal_id TEXT;
ALTER TABLE platform_executions ADD COLUMN actor_principal_id TEXT;
ALTER TABLE platform_executions ADD COLUMN acting_for_principal_id TEXT;
ALTER TABLE platform_executions ADD COLUMN executed_by_principal_id TEXT;
ALTER TABLE platform_workflows ADD COLUMN requested_by_principal_id TEXT;
ALTER TABLE platform_workflows ADD COLUMN actor_principal_id TEXT;
ALTER TABLE platform_workflows ADD COLUMN acting_for_principal_id TEXT;
ALTER TABLE platform_workflows ADD COLUMN executed_by_principal_id TEXT;
CREATE INDEX IF NOT EXISTS idx_platform_executions_actor_principal ON platform_executions(actor_principal_id);
CREATE INDEX IF NOT EXISTS idx_platform_workflows_actor_principal ON platform_workflows(actor_principal_id);
