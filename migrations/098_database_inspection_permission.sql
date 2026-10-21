-- Database structure and operational metrics use a dedicated permission so
-- credentials and delegations can scope them independently of generic tools.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at)
VALUES ('database.inspect', 'Read database schema and operational statistics', 'medium', datetime('now'));

-- Preserve existing operator workflows while making the authority explicit
-- and separately attenuable on credentials and delegations.
INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'database.inspect', datetime('now')),
  ('administrator', 'database.inspect', datetime('now')),
  ('operator', 'database.inspect', datetime('now'));
