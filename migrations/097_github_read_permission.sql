-- GitHub CI output can disclose private repository and workflow metadata.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at)
VALUES ('github.read', 'Read GitHub repository and CI metadata', 'medium', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'github.read', datetime('now')),
  ('administrator', 'github.read', datetime('now'));
