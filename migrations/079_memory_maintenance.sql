CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('previewed', 'cancelled', 'applied', 'failed')),
  plan_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_project ON memory_maintenance_runs(project, updated_at DESC);
