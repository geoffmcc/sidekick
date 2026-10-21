-- Bind execution-node administration to scoped Core identities and audit actors.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('compute.nodes.manage', 'Authorize workspaces and revoke execution nodes', 'critical', datetime('now')),
  ('compute.jobs.cancel', 'Request cancellation of execution-node jobs', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'compute.nodes.manage', datetime('now')),
  ('administrator', 'compute.nodes.manage', datetime('now')),
  ('owner', 'compute.jobs.cancel', datetime('now')),
  ('administrator', 'compute.jobs.cancel', datetime('now'));
