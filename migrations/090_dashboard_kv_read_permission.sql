-- KV inspection can reveal durable state across projects and is aligned with the existing admin-only write surface.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('kv.read', 'Read Dashboard key-value records and project metadata', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('owner', 'kv.read', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('administrator', 'kv.read', datetime('now'));
