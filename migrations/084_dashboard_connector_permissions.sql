-- Explicit permissions for direct Dashboard access to connector records and lifecycle.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('connectors.read', 'Read managed connector configuration, health, and lifecycle events', 'high', datetime('now')),
  ('connectors.manage', 'Register, configure, enable, disable, or retire managed connectors', 'critical', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
SELECT 'owner', permission, datetime('now') FROM identity_permissions
WHERE permission IN ('connectors.read', 'connectors.manage');

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('administrator', 'connectors.read', datetime('now')),
  ('administrator', 'connectors.manage', datetime('now'));
