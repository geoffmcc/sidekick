CREATE TABLE IF NOT EXISTS identity_recovery_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (owner_principal_id) REFERENCES principals(principal_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_identity_recovery_owner
  ON identity_recovery_tokens(owner_principal_id, used_at, expires_at);
