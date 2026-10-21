-- Dashboard access to execution scope definitions and evaluation records.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('scopes.read', 'Read project-scoped execution snapshots and evaluate their coverage', 'high', datetime('now')),
  ('scopes.manage', 'Create project-scoped execution snapshots', 'critical', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
SELECT 'owner', permission, datetime('now') FROM identity_permissions
WHERE permission IN ('scopes.read', 'scopes.manage');

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('administrator', 'scopes.read', datetime('now')),
  ('administrator', 'scopes.manage', datetime('now'));
