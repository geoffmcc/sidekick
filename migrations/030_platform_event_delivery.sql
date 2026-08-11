-- Phase 6 / Track B: durable event delivery contract.
-- The event ledger remains the source of truth; these tables add explicit
-- subscriber, attempt, retry/dead-letter, and consumer-offset state without
-- pretending delivery is exactly once.

CREATE TABLE IF NOT EXISTS platform_event_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS platform_event_deliveries (
  delivery_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(subscription_id) REFERENCES platform_event_subscriptions(subscription_id),
  FOREIGN KEY(event_id) REFERENCES platform_execution_events(event_id)
);
CREATE TABLE IF NOT EXISTS platform_event_offsets (
  subscription_id TEXT PRIMARY KEY,
  last_event_id TEXT,
  last_event_rowid INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(subscription_id) REFERENCES platform_event_subscriptions(subscription_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_event_subscriptions_name ON platform_event_subscriptions(name);
CREATE INDEX IF NOT EXISTS idx_platform_event_subscriptions_type_state ON platform_event_subscriptions(event_type, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_event_deliveries_subscription_event ON platform_event_deliveries(subscription_id, event_id);
CREATE INDEX IF NOT EXISTS idx_platform_event_deliveries_status_next ON platform_event_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_platform_event_deliveries_event ON platform_event_deliveries(event_id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '4');
