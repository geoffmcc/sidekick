-- Principal-scoped project grants used by project-bound memory and data APIs.
CREATE TABLE IF NOT EXISTS platform_project_principal_access (
  project_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('read', 'write')),
  granted_by_principal_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (project_id, principal_id),
  FOREIGN KEY (project_id) REFERENCES platform_projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by_principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_project_principal_access_principal
  ON platform_project_principal_access(principal_id, revoked_at, project_id);

INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at)
VALUES ('projects.access.manage', 'Grant and revoke principal access to projects', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'projects.access.manage', datetime('now')),
  ('administrator', 'projects.access.manage', datetime('now'));
