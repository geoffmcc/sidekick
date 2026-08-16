-- Durable Core identity foundation. Identity is instance-local, not tenant data.
CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'agent', 'service', 'automation', 'system')),
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by_principal_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  FOREIGN KEY (created_by_principal_id) REFERENCES principals(principal_id)
);

CREATE INDEX IF NOT EXISTS idx_principals_type_enabled ON principals(principal_type, enabled);

CREATE TABLE IF NOT EXISTS human_users (
  principal_id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_scheme TEXT NOT NULL DEFAULT ('scrypt' || '_v1'),
  password_changed_at TEXT NOT NULL,
  last_login_at TEXT,
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS principal_roles (
  principal_id TEXT NOT NULL,
  role_name TEXT NOT NULL CHECK (role_name IN ('owner', 'administrator', 'operator', 'viewer', 'auditor')),
  assigned_by_principal_id TEXT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, role_name),
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_by_principal_id) REFERENCES principals(principal_id)
);

CREATE INDEX IF NOT EXISTS idx_principal_roles_role ON principal_roles(role_name, principal_id);

CREATE TABLE IF NOT EXISTS identity_bootstrap (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner_principal_id TEXT NOT NULL UNIQUE,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (owner_principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS identity_audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  principal_id TEXT,
  actor_principal_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id),
  FOREIGN KEY (actor_principal_id) REFERENCES principals(principal_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_audit_created ON identity_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_audit_principal ON identity_audit_events(principal_id, created_at DESC);
