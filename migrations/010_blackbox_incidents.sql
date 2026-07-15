-- Migration 010: Structured Black Box incident evidence system.
-- The runtime module also creates these tables defensively for upgraded nodes.

CREATE TABLE IF NOT EXISTS blackbox_incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  project TEXT,
  environment TEXT,
  host TEXT,
  severity TEXT NOT NULL DEFAULT 'unknown',
  lifecycle_state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detected_at TEXT,
  resolved_at TEXT,
  source TEXT,
  task_id TEXT,
  session_id TEXT,
  correlation_id TEXT,
  created_by TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  retention_class TEXT NOT NULL DEFAULT 'standard',
  expires_at TEXT,
  last_accessed_at TEXT,
  root_cause TEXT,
  resolution TEXT,
  current_diagnosis_id TEXT,
  redaction_status TEXT NOT NULL DEFAULT 'redacted',
  schema_version INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS blackbox_captures (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  capture_type TEXT NOT NULL DEFAULT 'initial',
  trigger TEXT,
  requested_sources_json TEXT NOT NULL DEFAULT '[]',
  profile TEXT NOT NULL DEFAULT 'standard',
  started_at TEXT,
  completed_at TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  duration_ms INTEGER,
  source_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  timed_out_count INTEGER NOT NULL DEFAULT 0,
  truncated_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  task_id TEXT,
  session_id TEXT,
  correlation_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  capture_version INTEGER NOT NULL DEFAULT 2,
  FOREIGN KEY(incident_id) REFERENCES blackbox_incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blackbox_sources (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  category TEXT,
  collector_type TEXT NOT NULL,
  command TEXT,
  arguments_preview_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  state TEXT NOT NULL DEFAULT 'queued',
  exit_code INTEGER,
  timeout_ms INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  original_byte_count INTEGER NOT NULL DEFAULT 0,
  stored_byte_count INTEGER NOT NULL DEFAULT 0,
  stdout_artifact TEXT,
  stderr_artifact TEXT,
  normalized_json TEXT NOT NULL DEFAULT '{}',
  redaction_count INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  error_message TEXT,
  content_hash TEXT,
  FOREIGN KEY(capture_id) REFERENCES blackbox_captures(id) ON DELETE CASCADE,
  FOREIGN KEY(incident_id) REFERENCES blackbox_incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blackbox_observations (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  observation_type TEXT NOT NULL,
  subject TEXT,
  value_json TEXT,
  unit TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  observed_at TEXT NOT NULL,
  validity TEXT NOT NULL DEFAULT 'current_at_capture',
  directness TEXT NOT NULL DEFAULT 'direct',
  evidence_ref TEXT,
  fingerprint TEXT,
  FOREIGN KEY(capture_id) REFERENCES blackbox_captures(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES blackbox_sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blackbox_analyses (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  capture_id TEXT,
  type TEXT NOT NULL DEFAULT 'llm',
  model TEXT,
  provider TEXT,
  prompt_version TEXT,
  created_at TEXT NOT NULL,
  summary TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]',
  hypotheses_json TEXT NOT NULL DEFAULT '[]',
  diagnosis TEXT,
  confidence_json TEXT NOT NULL DEFAULT '{}',
  recommended_actions_json TEXT NOT NULL DEFAULT '[]',
  cited_source_ids_json TEXT NOT NULL DEFAULT '[]',
  user_feedback TEXT,
  state TEXT NOT NULL DEFAULT 'completed',
  error TEXT,
  FOREIGN KEY(incident_id) REFERENCES blackbox_incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blackbox_notes (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  author TEXT,
  source TEXT,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'note',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(incident_id) REFERENCES blackbox_incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blackbox_links (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  capture_id TEXT,
  link_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT,
  url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(incident_id) REFERENCES blackbox_incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blackbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT,
  capture_id TEXT,
  source_id TEXT,
  event_type TEXT NOT NULL,
  actor TEXT,
  previous_state TEXT,
  new_state TEXT,
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blackbox_incidents_state ON blackbox_incidents(lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_blackbox_incidents_project ON blackbox_incidents(project, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_blackbox_captures_incident ON blackbox_captures(incident_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_blackbox_sources_capture ON blackbox_sources(capture_id, source_key);
CREATE INDEX IF NOT EXISTS idx_blackbox_observations_capture ON blackbox_observations(capture_id, observation_type);
CREATE INDEX IF NOT EXISTS idx_blackbox_events_incident ON blackbox_events(incident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blackbox_links_incident ON blackbox_links(incident_id, link_type);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '10');
INSERT OR REPLACE INTO meta (key, value) VALUES ('blackbox_schema_version', '10');
