-- Sidekick Compute v6: inspectable scheduling diagnostics

ALTER TABLE compute_jobs ADD COLUMN scheduling_diagnostics_json TEXT NOT NULL DEFAULT '{}';
