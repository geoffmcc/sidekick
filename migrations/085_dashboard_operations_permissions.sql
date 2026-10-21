-- Explicit permissions for Dashboard quick actions that bypass tool dispatch.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('dashboard.operations.read', 'Read Dashboard service health, deployment metadata, failures, and service logs', 'high', datetime('now')),
  ('dashboard.operations.manage', 'Restart Sidekick services through Dashboard operations', 'critical', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
SELECT 'owner', permission, datetime('now') FROM identity_permissions
WHERE permission IN ('dashboard.operations.read', 'dashboard.operations.manage');

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('administrator', 'dashboard.operations.read', datetime('now')),
  ('administrator', 'dashboard.operations.manage', datetime('now'));
