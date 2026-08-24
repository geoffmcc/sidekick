-- Governed Security Research source repositories and immutable snapshots.
CREATE TABLE IF NOT EXISTS platform_research_source_repositories (
  repository_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'directory',
  source_locator TEXT,
  remote_identity TEXT,
  default_authority_class TEXT NOT NULL DEFAULT 'derived_analysis_input',
  state TEXT NOT NULL DEFAULT 'active',
  selected_snapshot_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_research_source_repositories_campaign ON platform_research_source_repositories(campaign_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_source_repositories_project ON platform_research_source_repositories(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_research_source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  acquisition_operation_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'directory',
  requested_ref TEXT,
  resolved_commit_sha TEXT,
  branch TEXT,
  remote_identity TEXT,
  state TEXT NOT NULL DEFAULT 'staging',
  storage_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_root_hash TEXT NOT NULL DEFAULT '',
  file_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  max_depth INTEGER NOT NULL DEFAULT 0,
  authority TEXT NOT NULL DEFAULT 'derived_analysis_input',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  verification_at TEXT,
  archived_at TEXT,
  removed_at TEXT,
  verification_json TEXT NOT NULL DEFAULT '{}',
  authority_provenance_json TEXT NOT NULL DEFAULT '{}',
  semantic_index_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  retention_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(repository_id) REFERENCES platform_research_source_repositories(repository_id),
  FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_research_source_snapshots_repository ON platform_research_source_snapshots(repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_source_snapshots_campaign ON platform_research_source_snapshots(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_source_snapshots_state ON platform_research_source_snapshots(state, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_research_source_authority_claims (
  claim_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  authority_class TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  declaring_actor TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(snapshot_id) REFERENCES platform_research_source_snapshots(snapshot_id),
  FOREIGN KEY(repository_id) REFERENCES platform_research_source_repositories(repository_id),
  FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id)
 );
CREATE INDEX IF NOT EXISTS idx_research_source_authority_claims_snapshot ON platform_research_source_authority_claims(snapshot_id, declared_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_source_authority_claims_campaign ON platform_research_source_authority_claims(campaign_id, declared_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_source_authority_claims_project ON platform_research_source_authority_claims(project_id, declared_at DESC);

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '11');
