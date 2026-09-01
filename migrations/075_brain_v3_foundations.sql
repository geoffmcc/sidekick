-- Brain v3 durable foundations. Payloads are bounded JSON projections; raw
-- prompts, model chain-of-thought, and secrets are not stored here.
CREATE TABLE IF NOT EXISTS brain_task_spec_revisions (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  spec_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'compiled',
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision),
  CHECK(length(spec_json) <= 50000),
  CHECK(length(source) <= 64)
);
CREATE INDEX IF NOT EXISTS idx_brain_task_spec_revisions_spec ON brain_task_spec_revisions(spec_id, revision DESC);

CREATE TABLE IF NOT EXISTS brain_belief_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(length(state_json) <= 100000),
  CHECK(length(status) <= 32)
);
CREATE INDEX IF NOT EXISTS idx_brain_belief_snapshots_task_time ON brain_belief_snapshots(task_id, created_at DESC, revision DESC);
CREATE INDEX IF NOT EXISTS idx_brain_belief_snapshots_status ON brain_belief_snapshots(status, created_at DESC);

CREATE TABLE IF NOT EXISTS brain_cognitive_traces (
  trace_id TEXT PRIMARY KEY,
  task_id TEXT,
  trace_json TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK(length(trace_json) <= 600000),
  CHECK(event_count BETWEEN 0 AND 256)
);
CREATE INDEX IF NOT EXISTS idx_brain_cognitive_traces_task_time ON brain_cognitive_traces(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS brain_cognitive_metrics (
  trace_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(trace_id, metric_name),
  FOREIGN KEY(trace_id) REFERENCES brain_cognitive_traces(trace_id) ON DELETE CASCADE,
  CHECK(length(metric_name) <= 128)
);
CREATE INDEX IF NOT EXISTS idx_brain_cognitive_metrics_name_time ON brain_cognitive_metrics(metric_name, created_at DESC);

CREATE TABLE IF NOT EXISTS brain_evidence_graph_nodes (
  task_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  freshness TEXT NOT NULL DEFAULT 'unknown',
  completeness TEXT NOT NULL DEFAULT 'unknown',
  provenance TEXT NOT NULL DEFAULT 'server-recorded',
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, node_id),
  CHECK(length(node_id) <= 180),
  CHECK(length(summary) <= 1200),
  CHECK(length(node_type) <= 32)
);
CREATE INDEX IF NOT EXISTS idx_brain_graph_nodes_task_type ON brain_evidence_graph_nodes(task_id, node_type);

CREATE TABLE IF NOT EXISTS brain_evidence_graph_edges (
  task_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, from_id, to_id, relation),
  CHECK(length(from_id) <= 180),
  CHECK(length(to_id) <= 180),
  CHECK(length(relation) <= 32)
);
CREATE INDEX IF NOT EXISTS idx_brain_graph_edges_task ON brain_evidence_graph_edges(task_id, to_id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('brain_v3_foundations_schema_version', '1');
