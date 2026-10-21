-- Network scope definitions expose egress allowlists and can change tool reachability.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('network_scopes.read', 'Read managed outbound network scope definitions and references', 'high', datetime('now')),
  ('network_scopes.manage', 'Create, validate, update, diagnose, and change state of network scopes', 'critical', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
SELECT 'owner', permission, datetime('now') FROM identity_permissions
WHERE permission IN ('network_scopes.read', 'network_scopes.manage');

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('administrator', 'network_scopes.read', datetime('now')),
  ('administrator', 'network_scopes.manage', datetime('now'));
