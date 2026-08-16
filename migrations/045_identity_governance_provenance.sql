-- Identity-aware provenance on execution records. Additive and data-preserving.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at)
VALUES ('secrets.manage', 'Create, rotate, and delete encrypted secrets', 'critical', datetime('now'));
INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('owner', 'secrets.manage', datetime('now'));
INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('administrator', 'secrets.manage', datetime('now'));

ALTER TABLE tool_logs ADD COLUMN requested_by_principal_id TEXT;
ALTER TABLE tool_logs ADD COLUMN actor_principal_id TEXT;
ALTER TABLE tool_logs ADD COLUMN acting_for_principal_id TEXT;
ALTER TABLE tool_logs ADD COLUMN approved_by_principal_id TEXT;
ALTER TABLE tool_logs ADD COLUMN executed_by_principal_id TEXT;
ALTER TABLE tool_logs ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tool_logs_actor ON tool_logs(actor_principal_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tool_logs_requested_by ON tool_logs(requested_by_principal_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_identity_audit_actor_created ON identity_audit_events(actor_principal_id, created_at DESC);
