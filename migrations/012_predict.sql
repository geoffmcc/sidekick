-- Predict v1: Evidence-backed prediction and decision-support engine
-- Stores predictions, evidence links, feedback, audit events, and detector rules.

CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  explanation TEXT NOT NULL,
  project TEXT,
  session_id TEXT,
  task_id TEXT,
  time_horizon TEXT NOT NULL DEFAULT 'open_ended',
  probability REAL NOT NULL DEFAULT 0.5,
  confidence TEXT NOT NULL DEFAULT 'low',
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  recommended_action_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  fingerprint TEXT,
  rule_version TEXT NOT NULL DEFAULT 'predict-v1',
  observation_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  outcome TEXT,
  outcome_at TEXT,
  legacy INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_predictions_type ON predictions(type);
CREATE INDEX IF NOT EXISTS idx_predictions_project ON predictions(project);
CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions(status);
CREATE INDEX IF NOT EXISTS idx_predictions_fingerprint ON predictions(fingerprint);
CREATE INDEX IF NOT EXISTS idx_predictions_created ON predictions(created_at);
CREATE INDEX IF NOT EXISTS idx_predictions_expires ON predictions(expires_at);
CREATE INDEX IF NOT EXISTS idx_predictions_session ON predictions(session_id);

CREATE TABLE IF NOT EXISTS prediction_evidence (
  id TEXT PRIMARY KEY,
  prediction_id TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_timestamp TEXT,
  summary TEXT NOT NULL,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pred_evidence_prediction ON prediction_evidence(prediction_id);
CREATE INDEX IF NOT EXISTS idx_pred_evidence_source ON prediction_evidence(source_type);

CREATE TABLE IF NOT EXISTS prediction_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id TEXT NOT NULL,
  feedback TEXT NOT NULL,
  project TEXT,
  rule_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pred_feedback_prediction ON prediction_feedback(prediction_id);
CREATE INDEX IF NOT EXISTS idx_pred_feedback_project ON prediction_feedback(project);

CREATE TABLE IF NOT EXISTS prediction_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  prediction_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pred_audit_type ON prediction_audit(event_type);
CREATE INDEX IF NOT EXISTS idx_pred_audit_prediction ON prediction_audit(prediction_id);

CREATE TABLE IF NOT EXISTS prediction_rules (
  rule_version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO prediction_rules (rule_version, name, description, enabled, config_json) VALUES
  ('predict-v1', 'predict-v1', 'Initial prediction rules', 1, '{}');

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '12');
