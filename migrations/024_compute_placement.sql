-- Sidekick Compute Placement v1
--
-- 1. Workers persist the enrollment token's data-classification scope so the
--    placement layer can enforce it at claim time (previously the token value
--    was discarded). Existing workers keep the historical implicit scope.
-- 2. Job attempts record accelerator provenance: what was requested, what the
--    worker claims actually ran, and how that claim was verified against the
--    OpenVINO model manifest (manifest_confirmed / manifest_confirmed_fallback
--    / unverified / rejected_claim).

ALTER TABLE compute_workers ADD COLUMN allowed_data_classifications_json TEXT NOT NULL DEFAULT '["public","internal","private"]';
ALTER TABLE compute_job_attempts ADD COLUMN requested_accelerator TEXT;
ALTER TABLE compute_job_attempts ADD COLUMN accelerator_verification TEXT;
