-- Sidekick Compute v5: explicit retry wait/backoff tracking

ALTER TABLE compute_jobs ADD COLUMN retry_after TEXT;

CREATE INDEX IF NOT EXISTS idx_compute_jobs_retry_after ON compute_jobs(status, retry_after);
