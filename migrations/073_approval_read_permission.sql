-- Separate approval inspection from approval resolution.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at)
VALUES ('approvals.read', 'Inspect pending approval metadata and previews', 'medium', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES
  ('owner', 'approvals.read', datetime('now')),
  ('administrator', 'approvals.read', datetime('now')),
  ('auditor', 'approvals.read', datetime('now'));
