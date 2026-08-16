CREATE TABLE IF NOT EXISTS identity_sessions (
  session_id_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  invalidated_at TEXT,
  user_agent TEXT,
  ip_address TEXT,
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_identity_sessions_principal
  ON identity_sessions(principal_id, expires_at);

CREATE TABLE IF NOT EXISTS identity_credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  verifier_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_by_principal_id TEXT,
  FOREIGN KEY (principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_principal_id) REFERENCES principals(principal_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_credentials_principal
  ON identity_credentials(principal_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_identity_credentials_prefix
  ON identity_credentials(token_prefix);
