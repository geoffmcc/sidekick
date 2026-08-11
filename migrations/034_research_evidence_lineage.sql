-- Phase 7 / Track C: evidence-linked findings and report metadata.
-- This stores bounded references and claims only; evidence bytes remain in
-- generic immutable artifact custody and are never embedded in these rows.
CREATE TABLE IF NOT EXISTS platform_research_findings (
  finding_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  hypothesis_id TEXT,
  test_run_id TEXT,
  title TEXT NOT NULL,
  claim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'analysis_only',
  impact TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id),
  FOREIGN KEY(hypothesis_id) REFERENCES platform_research_hypotheses(hypothesis_id),
  FOREIGN KEY(test_run_id) REFERENCES platform_research_test_runs(test_run_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_research_findings_campaign ON platform_research_findings(campaign_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_research_findings_status ON platform_research_findings(status, updated_at DESC);
CREATE TABLE IF NOT EXISTS platform_research_reports (
  report_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  artifact_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  finding_refs_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id),
  FOREIGN KEY(artifact_id) REFERENCES platform_artifacts(artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_research_reports_campaign ON platform_research_reports(campaign_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_research_reports_status ON platform_research_reports(status, updated_at DESC);
INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '8');
