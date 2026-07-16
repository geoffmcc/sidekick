-- Sidekick Compute v4: versioned and bounded job contract metadata

ALTER TABLE compute_jobs ADD COLUMN protocol_version TEXT NOT NULL DEFAULT '1';
ALTER TABLE compute_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
ALTER TABLE compute_jobs ADD COLUMN expires_at TEXT;
ALTER TABLE compute_jobs ADD COLUMN retry_policy_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE compute_jobs ADD COLUMN resource_requirements_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE compute_jobs ADD COLUMN artifact_expectations_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE compute_jobs ADD COLUMN output_limits_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_compute_jobs_priority ON compute_jobs(priority, created_at);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_expires ON compute_jobs(expires_at);
