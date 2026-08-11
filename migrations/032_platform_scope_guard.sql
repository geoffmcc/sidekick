-- Phase 7 / Track C: versioned scope snapshots and fail-closed guard records.
-- Target values are runtime data. Reporting and events expose digests/counts,
-- not target material.

CREATE TABLE IF NOT EXISTS platform_scope_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  rules_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  supersedes_snapshot_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(supersedes_snapshot_id) REFERENCES platform_scope_snapshots(snapshot_id)
);
CREATE TABLE IF NOT EXISTS platform_scope_targets (
  target_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value_digest TEXT NOT NULL,
  target_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(snapshot_id) REFERENCES platform_scope_snapshots(snapshot_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_scope_snapshot_digest ON platform_scope_snapshots(digest);
CREATE INDEX IF NOT EXISTS idx_platform_scope_snapshot_project ON platform_scope_snapshots(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_scope_snapshot_state_expiry ON platform_scope_snapshots(state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_scope_target_value ON platform_scope_targets(snapshot_id, kind, value_digest);
CREATE INDEX IF NOT EXISTS idx_platform_scope_target_snapshot ON platform_scope_targets(snapshot_id, kind);

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '6');
