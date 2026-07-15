-- Migration 011: Platform kernel foundations.
-- Adds additive execution, event, artifact, and transition-audit tables used by
-- future adapters. Existing feature-specific state remains authoritative until
-- each subsystem is migrated through compatibility adapters.

CREATE TABLE IF NOT EXISTS platform_executions (
  execution_id TEXT PRIMARY KEY,
  parent_execution_id TEXT,
  root_execution_id TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  workflow_id TEXT,
  project_id TEXT,
  incident_id TEXT,
  change_set_id TEXT,
  actor_id TEXT,
  client_id TEXT,
  trigger_type TEXT,
  operation_type TEXT NOT NULL,
  tool_name TEXT,
  tool_action TEXT,
  resource_scope TEXT,
  environment TEXT,
  state TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'unknown',
  approval_state TEXT NOT NULL DEFAULT 'not_required',
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deadline_at TEXT,
  heartbeat_at TEXT,
  result_status TEXT,
  error_category TEXT,
  result_summary TEXT,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT,
  span_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(parent_execution_id) REFERENCES platform_executions(execution_id)
);

CREATE TABLE IF NOT EXISTS platform_execution_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  project_id TEXT,
  environment TEXT,
  execution_id TEXT,
  root_execution_id TEXT,
  task_id TEXT,
  session_id TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  payload_json TEXT NOT NULL DEFAULT '{}',
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  dedupe_key TEXT,
  causation_id TEXT,
  correlation_id TEXT,
  redaction_state TEXT NOT NULL DEFAULT 'redacted',
  FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id)
);

CREATE TABLE IF NOT EXISTS platform_artifacts (
  artifact_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  project_id TEXT,
  execution_id TEXT,
  task_id TEXT,
  session_id TEXT,
  producer TEXT,
  storage_ref TEXT NOT NULL,
  content_type TEXT,
  byte_size INTEGER,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  retention_class TEXT NOT NULL DEFAULT 'standard',
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  redaction_state TEXT NOT NULL DEFAULT 'unknown',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lineage_json TEXT NOT NULL DEFAULT '{}',
  verification_json TEXT NOT NULL DEFAULT '{}',
  supersedes_artifact_id TEXT,
  deleted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id),
  FOREIGN KEY(supersedes_artifact_id) REFERENCES platform_artifacts(artifact_id)
);

CREATE TABLE IF NOT EXISTS platform_execution_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id),
  FOREIGN KEY(event_id) REFERENCES platform_execution_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_executions_root ON platform_executions(root_execution_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_executions_parent ON platform_executions(parent_execution_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_executions_project ON platform_executions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_executions_state ON platform_executions(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_executions_trace ON platform_executions(trace_id, span_id);
CREATE INDEX IF NOT EXISTS idx_platform_events_execution ON platform_execution_events(execution_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_platform_events_correlation ON platform_execution_events(correlation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_platform_events_type ON platform_execution_events(event_type, timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_events_dedupe ON platform_execution_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_artifacts_execution ON platform_artifacts(execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_artifacts_project ON platform_artifacts(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_artifacts_hash ON platform_artifacts(content_hash);
CREATE INDEX IF NOT EXISTS idx_platform_transitions_execution ON platform_execution_transitions(execution_id, created_at);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '11');
INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '1');
