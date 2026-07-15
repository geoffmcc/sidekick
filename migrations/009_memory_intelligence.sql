-- Migration 009: Memory intelligence foundations
-- Adds typed memory metadata, evidence, entities, handoffs, and task sessions
-- without replacing existing KV, context, or memories rows.

ALTER TABLE memories ADD COLUMN memory_class TEXT DEFAULT 'semantic';
ALTER TABLE memories ADD COLUMN primary_scope_type TEXT DEFAULT 'project';
ALTER TABLE memories ADD COLUMN primary_scope_id TEXT;
ALTER TABLE memories ADD COLUMN source_type TEXT;
ALTER TABLE memories ADD COLUMN evidence_excerpt TEXT;
ALTER TABLE memories ADD COLUMN extraction_method TEXT;
ALTER TABLE memories ADD COLUMN directness TEXT DEFAULT 'direct';
ALTER TABLE memories ADD COLUMN source_authority INTEGER DEFAULT 5;
ALTER TABLE memories ADD COLUMN confidence_json TEXT DEFAULT '{}';
ALTER TABLE memories ADD COLUMN recorded_at TEXT;
ALTER TABLE memories ADD COLUMN source_timestamp TEXT;
ALTER TABLE memories ADD COLUMN observed_at TEXT;
ALTER TABLE memories ADD COLUMN valid_from TEXT;
ALTER TABLE memories ADD COLUMN valid_to TEXT;
ALTER TABLE memories ADD COLUMN revalidate_after TEXT;
ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN sensitivity TEXT DEFAULT 'normal';
ALTER TABLE memories ADD COLUMN current INTEGER DEFAULT 1;
ALTER TABLE memories ADD COLUMN supersedes_id TEXT;
ALTER TABLE memories ADD COLUMN conflict_group TEXT;
ALTER TABLE memories ADD COLUMN fingerprint TEXT;

UPDATE memories
SET recorded_at = COALESCE(recorded_at, created_at),
    observed_at = COALESCE(observed_at, last_seen_at, created_at),
    valid_from = COALESCE(valid_from, created_at),
    primary_scope_id = COALESCE(primary_scope_id, project),
    source_type = COALESCE(source_type, source),
    fingerprint = COALESCE(fingerprint, lower(type || '|' || COALESCE(project, '') || '|' || content));

CREATE TABLE IF NOT EXISTS memory_evidence (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_location TEXT,
  source_timestamp TEXT,
  artifact_hash TEXT,
  evidence_excerpt TEXT NOT NULL,
  extraction_method TEXT,
  directness TEXT DEFAULT 'direct',
  authority INTEGER DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(memory_id) REFERENCES memories(id)
);

CREATE TABLE IF NOT EXISTS memory_entities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  primary_scope_type TEXT,
  primary_scope_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_verified_at TEXT,
  UNIQUE(entity_type, canonical_name)
);

CREATE TABLE IF NOT EXISTS memory_relationships (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  scope_type TEXT,
  scope_id TEXT,
  evidence_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(from_entity_id) REFERENCES memory_entities(id),
  FOREIGN KEY(to_entity_id) REFERENCES memory_entities(id),
  FOREIGN KEY(evidence_id) REFERENCES memory_evidence(id)
);

CREATE TABLE IF NOT EXISTS memory_handoffs (
  id TEXT PRIMARY KEY,
  kv_key TEXT UNIQUE,
  project TEXT,
  title TEXT,
  source TEXT,
  task_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  previous_id TEXT,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  redacted_content TEXT NOT NULL,
  extraction_state TEXT NOT NULL DEFAULT 'pending',
  extraction_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_task_sessions (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  project TEXT,
  source TEXT,
  client_session_id TEXT,
  working_directory TEXT,
  repository TEXT,
  branch TEXT,
  environment TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  supplied_context TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  current_plan TEXT,
  current_hypothesis TEXT,
  completed_steps_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  next_step TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,
  final_summary TEXT,
  acceptance_state TEXT,
  memory_brief_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  actor TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_class_scope ON memories(memory_class, primary_scope_type, primary_scope_id);
CREATE INDEX IF NOT EXISTS idx_memories_current ON memories(current, enabled, state);
CREATE INDEX IF NOT EXISTS idx_memories_validity ON memories(valid_from, valid_to, expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_revalidate ON memories(revalidate_after);
CREATE INDEX IF NOT EXISTS idx_memories_fingerprint ON memories(fingerprint);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory ON memory_evidence(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_source ON memory_evidence(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_entities_type_name ON memory_entities(entity_type, canonical_name);
CREATE INDEX IF NOT EXISTS idx_memory_relationships_from ON memory_relationships(from_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_memory_relationships_to ON memory_relationships(to_entity_id, relation_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_relationships_unique ON memory_relationships(from_entity_id, relation_type, to_entity_id, COALESCE(scope_type, ''), COALESCE(scope_id, ''));
CREATE INDEX IF NOT EXISTS idx_memory_handoffs_project ON memory_handoffs(project, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_handoffs_hash ON memory_handoffs(content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_task_sessions_project ON memory_task_sessions(project, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_audit_target ON memory_audit_events(target_type, target_id, created_at DESC);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9');
