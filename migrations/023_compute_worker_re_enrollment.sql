-- Sidekick Compute: worker re-enrollment tracking (Phase 4)
--
-- Lets an admin issue an enrollment token scoped to an existing node so a worker
-- that lost its credential can recover its identity via the token. re_enrollment_of
-- records the node the token is authorized to replace; replaced_worker_id records
-- which worker a consumed token actually renewed. Also covered by ensureColumn()
-- in worker-manager.js for ensureSchema-only paths (tests).

ALTER TABLE compute_enrollment_tokens ADD COLUMN re_enrollment_of TEXT;
ALTER TABLE compute_enrollment_tokens ADD COLUMN replaced_worker_id TEXT;

CREATE INDEX IF NOT EXISTS idx_compute_enrollment_reenroll ON compute_enrollment_tokens(re_enrollment_of);
