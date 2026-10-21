-- Prediction content is derived from operational histories and must be read
-- only by explicitly authorized principals within their project memberships.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('predictions.read', 'Read predictions and their evidence within authorized project scope', 'medium', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('owner', 'predictions.read', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('administrator', 'predictions.read', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('operator', 'predictions.read', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('viewer', 'predictions.read', datetime('now'));
