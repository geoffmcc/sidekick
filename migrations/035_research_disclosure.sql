-- Phase 7 / Track C: human-gated disclosure metadata.
-- Bodies, addresses, and vendor content remain outside this metadata ledger.
CREATE TABLE IF NOT EXISTS platform_research_disclosures (
  disclosure_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  artifact_id TEXT,
  recipient_ref TEXT,
  approval_ref TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id),
  FOREIGN KEY(report_id) REFERENCES platform_research_reports(report_id),
  FOREIGN KEY(artifact_id) REFERENCES platform_artifacts(artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_research_disclosures_campaign ON platform_research_disclosures(campaign_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_research_disclosures_state ON platform_research_disclosures(state, updated_at DESC);
INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '9');
