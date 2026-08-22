-- Durable Agent task projection. Raw model/tool payloads remain in governed
-- evidence/artifact stores; these tables contain bounded redacted metadata.
CREATE TABLE IF NOT EXISTS agent_tasks (
  task_id TEXT PRIMARY KEY,
  root_task_id TEXT NOT NULL,
  parent_task_id TEXT,
  session_id TEXT,
  execution_id TEXT,
  project_id TEXT,
  actor_id TEXT,
  requested_by_principal_id TEXT,
  actor_principal_id TEXT,
  acting_for_principal_id TEXT,
  objective TEXT NOT NULL,
  normalized_objective TEXT NOT NULL,
  goal_json TEXT NOT NULL,
  profile TEXT NOT NULL,
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  current_plan_revision INTEGER NOT NULL DEFAULT 0,
  requirements_json TEXT NOT NULL DEFAULT '[]',
  budget_json TEXT NOT NULL DEFAULT '{}',
  usage_json TEXT NOT NULL DEFAULT '{}',
  workspace_ref TEXT,
  model_version TEXT,
  prompt_version TEXT,
  policy_version TEXT,
  capability_registry_version TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  next_action TEXT,
  result_json TEXT,
  verification_json TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(length(objective) <= 20000),
  CHECK(length(normalized_objective) <= 20000),
  CHECK(length(goal_json) <= 50000),
  CHECK(length(requirements_json) <= 100000),
  CHECK(length(budget_json) <= 20000),
  CHECK(length(usage_json) <= 20000),
  CHECK(length(checkpoint_json) <= 100000),
  CHECK(length(result_json) <= 100000),
  CHECK(length(verification_json) <= 50000)
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_project_updated ON agent_tasks(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_state_updated ON agent_tasks(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_root_updated ON agent_tasks(root_task_id, updated_at ASC);

CREATE TABLE IF NOT EXISTS agent_task_plan_revisions (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, revision),
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  CHECK(length(plan_json) <= 100000)
);

CREATE TABLE IF NOT EXISTS agent_task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  CHECK(length(payload_json) <= 30000)
);
CREATE INDEX IF NOT EXISTS idx_agent_task_events_task_time ON agent_task_events(task_id, created_at ASC, event_id ASC);

CREATE TABLE IF NOT EXISTS agent_task_failures (
  failure_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  action_fingerprint TEXT NOT NULL,
  capability TEXT,
  error_class TEXT NOT NULL,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  changed_condition INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  CHECK(length(detail) <= 2000)
);
CREATE INDEX IF NOT EXISTS idx_agent_task_failures_fingerprint ON agent_task_failures(task_id, action_fingerprint, created_at DESC);

INSERT OR REPLACE INTO meta (key, value) VALUES ('agent_task_schema_version', '1');
