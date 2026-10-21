-- Durable webhook bodies contain untrusted third-party data and need separate
-- read and destructive-clear grants.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('webhooks.read', 'Read retained external webhook payloads', 'medium', datetime('now')),
  ('webhooks.manage', 'Clear retained external webhook payloads', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'webhooks.read', datetime('now')),
  ('administrator', 'webhooks.read', datetime('now')),
  ('owner', 'webhooks.manage', datetime('now')),
  ('administrator', 'webhooks.manage', datetime('now'));
