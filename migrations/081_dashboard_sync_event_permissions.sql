-- Explicit permissions for Dashboard routes that operate directly on the
-- platform kernel or sync store rather than going through the tool dispatcher.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('events.read', 'Read Dashboard event subscriptions and delivery records', 'medium', datetime('now')),
  ('events.manage', 'Create, pause, resume, and requeue Dashboard event delivery', 'high', datetime('now')),
  ('sync.read', 'Read or export synchronized Sidekick state', 'high', datetime('now')),
  ('sync.manage', 'Change sync identity or import synchronized Sidekick state', 'critical', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
SELECT 'owner', permission, datetime('now') FROM identity_permissions
WHERE permission IN ('events.read', 'events.manage', 'sync.read', 'sync.manage');

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('administrator', 'audit.read', datetime('now')),
  ('administrator', 'events.read', datetime('now')),
  ('administrator', 'events.manage', datetime('now')),
  ('administrator', 'sync.read', datetime('now')),
  ('administrator', 'sync.manage', datetime('now')),
  ('auditor', 'events.read', datetime('now'));
