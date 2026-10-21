-- Dashboard catalogs expose internal tool, knowledge, procedure, and model inventory.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('dashboard.catalog.read', 'Read Dashboard tool, model, knowledge, and procedure catalogs', 'medium', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('owner', 'dashboard.catalog.read', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('administrator', 'dashboard.catalog.read', datetime('now'));
