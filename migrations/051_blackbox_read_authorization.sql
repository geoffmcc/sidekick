-- Black Box incident evidence is operationally sensitive and must not be
-- exposed to every authenticated Dashboard principal.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at)
VALUES ('blackbox.read', 'Read Black Box incident evidence and diagnostics', 'medium', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES
  ('administrator', 'blackbox.read', datetime('now')),
  ('auditor', 'blackbox.read', datetime('now'));

-- Owners receive the complete permission catalog by the identity
-- authorization migration, but this explicit insert also covers databases
-- where that catalog was applied before this permission was introduced.
INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('owner', 'blackbox.read', datetime('now'));
