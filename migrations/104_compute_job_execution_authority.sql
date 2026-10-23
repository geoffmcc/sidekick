-- Private, non-secret authority snapshot for Core-executed durable inference.
-- Runtime ensureColumn is idempotent with this ALTER for runtime-first startup.
ALTER TABLE compute_jobs ADD COLUMN execution_authority_json TEXT NOT NULL DEFAULT '{}';
