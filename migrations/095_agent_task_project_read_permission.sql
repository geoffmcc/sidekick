-- Durable Agent task content may contain project-derived results. Keep task
-- reads scoped to active project access as well as task ownership.
INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at)
VALUES ('agent.tasks.read', 'Read and control own durable Agent tasks in an authorized project', 'low', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
SELECT role_name, 'agent.tasks.read', datetime('now')
FROM (SELECT 'owner' AS role_name UNION ALL SELECT 'administrator' UNION ALL SELECT 'operator' UNION ALL SELECT 'viewer' UNION ALL SELECT 'auditor');
