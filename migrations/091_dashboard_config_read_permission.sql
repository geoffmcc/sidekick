-- Runtime configuration exposes deployment topology and may include credential-bearing values.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('dashboard.config.read', 'Read redacted Dashboard runtime configuration', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('owner', 'dashboard.config.read', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('administrator', 'dashboard.config.read', datetime('now'));
