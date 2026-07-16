-- Sidekick Compute v2: worker credentials and lease recovery metadata

ALTER TABLE compute_workers ADD COLUMN credential_hash TEXT;
ALTER TABLE compute_workers ADD COLUMN credential_rotated_at TEXT;
ALTER TABLE compute_workers ADD COLUMN protocol_version TEXT NOT NULL DEFAULT '1';

ALTER TABLE compute_jobs ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE compute_jobs ADD COLUMN cancel_requested_by TEXT;
ALTER TABLE compute_jobs ADD COLUMN idempotency_key TEXT;

ALTER TABLE compute_job_attempts ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE compute_job_attempts ADD COLUMN progress_message TEXT;
ALTER TABLE compute_job_attempts ADD COLUMN lease_acquired_at TEXT;
ALTER TABLE compute_job_attempts ADD COLUMN lease_expires_at TEXT;
ALTER TABLE compute_job_attempts ADD COLUMN execution_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_compute_jobs_idempotency ON compute_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
