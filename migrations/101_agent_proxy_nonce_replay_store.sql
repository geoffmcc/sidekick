-- Shared replay protection across Agent processes using the same Core SQLite database.
CREATE TABLE IF NOT EXISTS agent_proxy_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL CHECK (expires_at > 0)
);
CREATE INDEX IF NOT EXISTS idx_agent_proxy_nonces_expires_at ON agent_proxy_nonces(expires_at);
