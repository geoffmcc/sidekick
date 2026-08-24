-- Durable operator-created outbound network scope registry and immutable revisions.
CREATE TABLE IF NOT EXISTS platform_network_scopes (
  scope_id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  current_revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS platform_network_scope_revisions (
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY(scope_id, revision),
  FOREIGN KEY(scope_id) REFERENCES platform_network_scopes(scope_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_network_scope_digest ON platform_network_scope_revisions(digest);
CREATE INDEX IF NOT EXISTS idx_network_scope_state ON platform_network_scopes(state, name);
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '66');
INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '12');
