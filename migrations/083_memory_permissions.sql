-- Explicit memory operation permissions for tool and direct Dashboard paths.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('memory.read', 'Read project-scoped persistent memory and handoff context', 'medium', datetime('now')),
  ('memory.write', 'Create or modify project-scoped persistent memory and handoffs', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'memory.read', datetime('now')),
  ('owner', 'memory.write', datetime('now')),
  ('administrator', 'memory.read', datetime('now')),
  ('administrator', 'memory.write', datetime('now')),
  ('operator', 'memory.read', datetime('now')),
  ('operator', 'memory.write', datetime('now')),
  ('viewer', 'memory.read', datetime('now'));
