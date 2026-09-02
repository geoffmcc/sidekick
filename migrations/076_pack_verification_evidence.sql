-- Receipt-bound capability-pack verification evidence.
-- Legacy metadata_json.maturity_evidence remains historical only; it cannot
-- promote a pack because this table is populated only after server validation.
CREATE TABLE IF NOT EXISTS platform_pack_verification_evidence (
  verification_id TEXT PRIMARY KEY,
  pack_name TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  package_hash TEXT,
  config_fingerprint TEXT NOT NULL,
  lifecycle_epoch INTEGER NOT NULL,
  health_fingerprint TEXT NOT NULL,
  recipe_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  project_ref TEXT,
  scope_revision TEXT,
  provider_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'verified',
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK(length(pack_name) <= 128),
  CHECK(length(pack_version) <= 64),
  CHECK(length(config_fingerprint) <= 128),
  CHECK(length(health_fingerprint) <= 128),
  CHECK(length(recipe_version) <= 64),
  CHECK(length(evidence_json) <= 50000),
  CHECK(length(result_digest) <= 128),
  CHECK(length(actor_ref) <= 256),
  CHECK(length(project_ref) <= 256),
  CHECK(length(scope_revision) <= 256),
  CHECK(status IN ('verified', 'expired', 'revoked', 'superseded', 'legacy', 'invalid')),
  CHECK(legacy IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_pack_verification_pack_time
  ON platform_pack_verification_evidence(pack_name, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pack_verification_status_time
  ON platform_pack_verification_evidence(status, expires_at, observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_verification_pack_result
  ON platform_pack_verification_evidence(pack_name, result_digest);

INSERT OR REPLACE INTO meta (key, value) VALUES ('capability_pack_verification_schema_version', '1');
