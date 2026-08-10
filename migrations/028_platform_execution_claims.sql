-- Migration 028: Platform execution claim/lease/checkpoint/cancel contract.
--
-- Phase 4 / Track B of the platform convergence roadmap, first slice. Adds a
-- kernel-owned claim table so schedulers (delay first; cron/watch/runbooks in
-- later slices) can take a fenced, leased claim on a platform execution before
-- dispatching work: one claimant of record, write-fenced by claim_epoch,
-- cooperative cancellation via cancel_requested, and a recovery scan that
-- orphans executions whose claim lease expired. Modeled on the proven
-- approval-continuation (task_checkpoints) and Compute (compute_jobs) claim
-- patterns; those layers keep their own storage and are not migrated.
--
-- All objects are created with CREATE TABLE IF NOT EXISTS so the migration is
-- idempotent regardless of whether the runtime kernel schema (which declares
-- the same DDL in src/platform/kernel-schema.js) ran first. Both boot paths
-- must produce byte-identical sqlite_master text;
-- test/kernel-migration-parity.test.js enforces it.

CREATE TABLE IF NOT EXISTS platform_execution_claims (
  execution_id TEXT PRIMARY KEY,
  claimed_by TEXT,
  claim_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_execution_claims_lease ON platform_execution_claims(lease_expires_at) WHERE lease_expires_at IS NOT NULL;

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '3');
