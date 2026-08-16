-- Bind approval decisions to Core principals and the action's authority context.
ALTER TABLE approvals ADD COLUMN requested_by_principal_id TEXT;
ALTER TABLE approvals ADD COLUMN actor_principal_id TEXT;
ALTER TABLE approvals ADD COLUMN acting_for_principal_id TEXT;
ALTER TABLE approvals ADD COLUMN approved_by_principal_id TEXT;
ALTER TABLE approvals ADD COLUMN executed_by_principal_id TEXT;
ALTER TABLE approvals ADD COLUMN requires_human_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_human_approval IN (0, 1));
ALTER TABLE approvals ADD COLUMN approval_policy TEXT;
CREATE INDEX IF NOT EXISTS idx_approvals_requested_principal ON approvals(requested_by_principal_id);
CREATE INDEX IF NOT EXISTS idx_approvals_actor_principal ON approvals(actor_principal_id);
CREATE INDEX IF NOT EXISTS idx_approvals_approved_principal ON approvals(approved_by_principal_id);
