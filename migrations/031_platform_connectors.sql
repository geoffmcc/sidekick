-- Phase 6 / Track B: generic connector lifecycle and secret-reference contract.
-- Connector rows store configuration and references only; secret values remain
-- behind the existing secret service boundary.

CREATE TABLE IF NOT EXISTS platform_connectors (
  connector_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'registered',
  endpoint TEXT,
  secret_ref TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  health_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_health_check_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_connectors_name ON platform_connectors(name);
CREATE INDEX IF NOT EXISTS idx_platform_connectors_type_state ON platform_connectors(type, state);
CREATE INDEX IF NOT EXISTS idx_platform_connectors_state_updated ON platform_connectors(state, updated_at DESC);

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '5');
