-- Dashboard webhook intake stores caller-controlled payloads in durable state.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('webhooks.receive', 'Submit webhook payloads to Dashboard durable storage', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('owner', 'webhooks.receive', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
VALUES ('administrator', 'webhooks.receive', datetime('now'));
