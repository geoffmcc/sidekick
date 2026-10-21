-- Explicit per-service grants let machine identities receive narrow authority
-- without inheriting a broad human role bundle.
CREATE TABLE IF NOT EXISTS identity_principal_permissions (
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  assigned_by_principal_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, permission),
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT,
  FOREIGN KEY (permission) REFERENCES identity_permissions(permission) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_by_principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_identity_principal_permissions_permission
  ON identity_principal_permissions(permission, principal_id);
