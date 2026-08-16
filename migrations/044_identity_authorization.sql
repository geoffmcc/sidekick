-- Core authorization registry and bounded delegation.
CREATE TABLE IF NOT EXISTS identity_permissions (
  permission TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_role_permissions (
  role_name TEXT NOT NULL CHECK (role_name IN ('owner', 'administrator', 'operator', 'viewer', 'auditor')),
  permission TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (role_name, permission),
  FOREIGN KEY (permission) REFERENCES identity_permissions(permission) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS identity_delegations (
  delegation_id TEXT PRIMARY KEY,
  delegator_principal_id TEXT NOT NULL,
  delegate_principal_id TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_by_principal_id TEXT,
  FOREIGN KEY (delegator_principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT,
  FOREIGN KEY (delegate_principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_identity_delegations_delegate ON identity_delegations(delegate_principal_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_identity_delegations_delegator ON identity_delegations(delegator_principal_id, revoked_at, expires_at);

INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('users.read', 'Read local human accounts', 'low', datetime('now')),
  ('users.manage', 'Create, disable, reset, and manage local human accounts', 'high', datetime('now')),
  ('principals.read', 'Read non-human and system principals', 'low', datetime('now')),
  ('principals.manage', 'Create, disable, and manage principals', 'high', datetime('now')),
  ('roles.manage', 'Assign or remove privileged role bundles', 'critical', datetime('now')),
  ('credentials.create', 'Create scoped machine credentials', 'high', datetime('now')),
  ('credentials.read', 'Read machine credential metadata', 'low', datetime('now')),
  ('credentials.revoke', 'Revoke or rotate machine credentials', 'high', datetime('now')),
  ('packs.read', 'Read Capability Pack metadata', 'low', datetime('now')),
  ('packs.install', 'Install Capability Packs', 'critical', datetime('now')),
  ('packs.configure', 'Configure Capability Packs', 'high', datetime('now')),
  ('packs.manage', 'Enable, disable, upgrade, or uninstall Capability Packs', 'critical', datetime('now')),
  ('workflows.read', 'Read workflow definitions and runs', 'low', datetime('now')),
  ('workflows.create', 'Create workflow definitions', 'high', datetime('now')),
  ('workflows.execute', 'Execute bounded workflows', 'high', datetime('now')),
  ('workflows.manage', 'Manage workflow definitions and runs', 'critical', datetime('now')),
  ('secrets.read_metadata', 'List secret names and metadata without values', 'medium', datetime('now')),
  ('secrets.use', 'Use a secret through a governed operation', 'high', datetime('now')),
  ('secrets.read', 'Read raw secret values', 'critical', datetime('now')),
  ('audit.read', 'Read security and execution audit records', 'medium', datetime('now')),
  ('approvals.request', 'Request an approval', 'medium', datetime('now')),
  ('approvals.grant', 'Grant or reject an approval', 'high', datetime('now')),
  ('system.configure', 'Change privileged Sidekick configuration', 'critical', datetime('now')),
  ('tools.execute', 'Execute ordinary governed tools', 'medium', datetime('now')),
  ('tools.execute_high', 'Execute high-risk governed tools', 'high', datetime('now')),
  ('tools.execute_critical', 'Execute critical-risk governed tools', 'critical', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at)
SELECT 'owner', permission, datetime('now') FROM identity_permissions;

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('administrator', 'users.read', datetime('now')),
  ('administrator', 'users.manage', datetime('now')),
  ('administrator', 'principals.read', datetime('now')),
  ('administrator', 'principals.manage', datetime('now')),
  ('administrator', 'credentials.create', datetime('now')),
  ('administrator', 'credentials.read', datetime('now')),
  ('administrator', 'credentials.revoke', datetime('now')),
  ('administrator', 'packs.read', datetime('now')),
  ('administrator', 'packs.configure', datetime('now')),
  ('administrator', 'workflows.read', datetime('now')),
  ('administrator', 'workflows.create', datetime('now')),
  ('administrator', 'workflows.execute', datetime('now')),
  ('administrator', 'workflows.manage', datetime('now')),
  ('administrator', 'secrets.read_metadata', datetime('now')),
  ('administrator', 'secrets.use', datetime('now')),
  ('administrator', 'audit.read', datetime('now')),
  ('administrator', 'approvals.request', datetime('now')),
  ('administrator', 'approvals.grant', datetime('now')),
  ('administrator', 'tools.execute', datetime('now')),
  ('administrator', 'tools.execute_high', datetime('now')),
  ('operator', 'packs.read', datetime('now')),
  ('operator', 'workflows.read', datetime('now')),
  ('operator', 'workflows.execute', datetime('now')),
  ('operator', 'secrets.use', datetime('now')),
  ('operator', 'approvals.request', datetime('now')),
  ('operator', 'tools.execute', datetime('now')),
  ('viewer', 'users.read', datetime('now')),
  ('viewer', 'principals.read', datetime('now')),
  ('viewer', 'packs.read', datetime('now')),
  ('viewer', 'workflows.read', datetime('now')),
  ('viewer', 'secrets.read_metadata', datetime('now')),
  ('auditor', 'users.read', datetime('now')),
  ('auditor', 'principals.read', datetime('now')),
  ('auditor', 'audit.read', datetime('now')),
  ('auditor', 'workflows.read', datetime('now'));
