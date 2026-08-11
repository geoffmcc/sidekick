-- Phase 7 / Track C: bounded research workflow records.
-- These records describe authorized investigation work; they do not execute
-- tools or establish findings without execution and evidence.

CREATE TABLE IF NOT EXISTS platform_research_campaigns (
  campaign_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  scope_snapshot_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(scope_snapshot_id) REFERENCES platform_scope_snapshots(snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_research_campaigns_project ON platform_research_campaigns(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_research_campaigns_state ON platform_research_campaigns(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_research_hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  claim TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed',
  rationale TEXT,
  prerequisites_json TEXT NOT NULL DEFAULT '[]',
  criteria_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_research_hypotheses_campaign ON platform_research_hypotheses(campaign_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_research_hypotheses_state ON platform_research_hypotheses(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_research_test_runs (
  test_run_id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  execution_id TEXT,
  scope_snapshot_id TEXT,
  state TEXT NOT NULL DEFAULT 'not_run',
  environment_json TEXT NOT NULL DEFAULT '{}',
  outcome TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(hypothesis_id) REFERENCES platform_research_hypotheses(hypothesis_id),
  FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id),
  FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id),
  FOREIGN KEY(scope_snapshot_id) REFERENCES platform_scope_snapshots(snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_research_test_runs_hypothesis ON platform_research_test_runs(hypothesis_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_research_test_runs_execution ON platform_research_test_runs(execution_id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '7');
