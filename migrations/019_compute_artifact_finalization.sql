ALTER TABLE compute_artifacts ADD COLUMN worker_id TEXT;
ALTER TABLE compute_artifacts ADD COLUMN lease_id TEXT;
ALTER TABLE compute_artifacts ADD COLUMN state TEXT NOT NULL DEFAULT 'finalized';
ALTER TABLE compute_artifacts ADD COLUMN finalized_at TEXT;
