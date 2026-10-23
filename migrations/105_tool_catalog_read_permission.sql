-- Tool metadata and policy inspection are read-only and must not require the
-- generic permission used to execute ordinary tools.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at)
VALUES ('tools.catalog.read', 'Read tool metadata and effective policy decisions', 'low', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'tools.catalog.read', datetime('now')),
  ('administrator', 'tools.catalog.read', datetime('now')),
  ('operator', 'tools.catalog.read', datetime('now')),
  ('viewer', 'tools.catalog.read', datetime('now')),
  ('auditor', 'tools.catalog.read', datetime('now'));
