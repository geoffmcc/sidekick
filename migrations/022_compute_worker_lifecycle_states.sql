-- Sidekick Compute: multi-dimensional worker lifecycle states (Phase 1)
--
-- Splits the single `state` column into orthogonal dimensions so connection,
-- administrative, credential, and health concerns can be reasoned about
-- independently. The legacy `state` column is retained as a derived value for
-- backward compatibility (see deriveLegacyState in worker-manager.js).
--
-- These same columns are also added defensively at runtime by ensureColumn() in
-- worker-manager.js. Migrations run before compute.initialize() (see src/index.js),
-- so on managed databases this migration adds the columns first and the runtime
-- ensureColumn calls become no-ops; on ensureSchema-only paths (e.g. tests) the
-- runtime calls add them instead. The two must stay in sync.

ALTER TABLE compute_workers ADD COLUMN connection_state TEXT NOT NULL DEFAULT 'offline';
ALTER TABLE compute_workers ADD COLUMN admin_state TEXT NOT NULL DEFAULT 'enabled';
ALTER TABLE compute_workers ADD COLUMN credential_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE compute_workers ADD COLUMN health_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE compute_workers ADD COLUMN disconnected_at TEXT;
ALTER TABLE compute_workers ADD COLUMN last_disconnect_reason TEXT;

-- Backfill orthogonal dimensions from the existing legacy state column.
UPDATE compute_workers SET
  connection_state = CASE WHEN state = 'online' THEN 'online' ELSE 'offline' END,
  admin_state = CASE
    WHEN state = 'maintenance' THEN 'maintenance'
    WHEN state = 'draining' THEN 'draining'
    ELSE 'enabled' END,
  credential_state = CASE WHEN state = 'revoked' THEN 'revoked' ELSE 'active' END,
  health_state = CASE WHEN state = 'degraded' THEN 'degraded' ELSE 'unknown' END;

CREATE INDEX IF NOT EXISTS idx_compute_workers_connection ON compute_workers(connection_state);
CREATE INDEX IF NOT EXISTS idx_compute_workers_admin ON compute_workers(admin_state);
CREATE INDEX IF NOT EXISTS idx_compute_workers_credential ON compute_workers(credential_state);
