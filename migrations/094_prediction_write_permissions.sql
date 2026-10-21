-- Prediction analysis and feedback mutate project-scoped prediction state.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('predictions.write', 'Analyze and update predictions within authorized project scope', 'medium', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('owner', 'predictions.write', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('administrator', 'predictions.write', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('operator', 'predictions.write', datetime('now'));
