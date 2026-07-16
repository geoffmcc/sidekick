-- Sidekick Compute v3: worker runtime metadata for routing and operations

ALTER TABLE compute_workers ADD COLUMN model_inventory_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE compute_workers ADD COLUMN limits_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE compute_workers ADD COLUMN health_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE compute_workers ADD COLUMN last_health_check TEXT;
