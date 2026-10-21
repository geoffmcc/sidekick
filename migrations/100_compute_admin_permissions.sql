-- Scope the direct Compute administrative API independently from its legacy installation key.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('compute.jobs.create', 'Create Compute jobs for authorized projects', 'high', datetime('now')),
  ('compute.jobs.manage', 'Cancel or retry Compute jobs within authorized projects', 'critical', datetime('now')),
  ('compute.jobs.recover', 'Recover expired leases across Compute jobs', 'critical', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'compute.jobs.create', datetime('now')),
  ('administrator', 'compute.jobs.create', datetime('now')),
  ('owner', 'compute.jobs.manage', datetime('now')),
  ('administrator', 'compute.jobs.manage', datetime('now')),
  ('owner', 'compute.jobs.recover', datetime('now'));
