-- Sidekick Compute: bounded local-only worker telemetry.
-- The worker heartbeat is authenticated; the server still sanitizes this field
-- before persistence and exposes it only through an explicit projection.
ALTER TABLE compute_workers ADD COLUMN telemetry_json TEXT NOT NULL DEFAULT '{}';
