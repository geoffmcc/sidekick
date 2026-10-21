-- Direct Dashboard Compute reads expose infrastructure and job state outside the dispatcher.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('compute.nodes.read', 'Read Compute providers, workers, health, and enrollment metadata', 'high', datetime('now')),
  ('compute.jobs.read', 'Read Compute jobs, attempts, artifacts, and aggregate state', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
SELECT 'owner', permission, datetime('now') FROM identity_permissions
WHERE permission IN ('compute.nodes.read', 'compute.jobs.read');

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('administrator', 'compute.nodes.read', datetime('now')),
  ('administrator', 'compute.jobs.read', datetime('now'));
