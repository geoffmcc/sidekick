-- Durable hierarchical plans, repair decisions, escalation packages, and
-- bounded work-package ownership. All model-authored content remains data.
CREATE TABLE IF NOT EXISTS agent_hierarchical_plans (
  plan_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
  objective TEXT NOT NULL, milestones_json TEXT NOT NULL DEFAULT '[]',
  work_packages_json TEXT NOT NULL DEFAULT '[]', steps_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]', gates_json TEXT NOT NULL DEFAULT '[]',
  active_package TEXT, stopping_conditions_json TEXT NOT NULL DEFAULT '[]',
  provenance_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  UNIQUE(task_id, revision), CHECK(length(objective)<=20000), CHECK(length(milestones_json)<=50000),
  CHECK(length(work_packages_json)<=50000), CHECK(length(steps_json)<=50000), CHECK(length(dependencies_json)<=30000),
  CHECK(length(gates_json)<=30000), CHECK(length(stopping_conditions_json)<=12000), CHECK(length(provenance_json)<=12000)
);
CREATE TABLE IF NOT EXISTS agent_escalation_packages (
  escalation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, operation_ref TEXT,
  requested_operation TEXT NOT NULL, reason TEXT NOT NULL, target_ref TEXT,
  expected_effect TEXT NOT NULL, risk_class TEXT NOT NULL, effect_class TEXT NOT NULL,
  pre_state_json TEXT NOT NULL DEFAULT '{}', attempts_json TEXT NOT NULL DEFAULT '[]',
  verification_plan_json TEXT NOT NULL DEFAULT '{}', rollback_plan_json TEXT NOT NULL DEFAULT '{}',
  alternatives_json TEXT NOT NULL DEFAULT '[]', consequences_json TEXT NOT NULL DEFAULT '{}',
  requested_scope TEXT NOT NULL, approval_mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  CHECK(length(requested_operation)<=2000), CHECK(length(reason)<=4000), CHECK(length(pre_state_json)<=20000),
  CHECK(length(attempts_json)<=30000), CHECK(length(verification_plan_json)<=12000), CHECK(length(rollback_plan_json)<=12000),
  CHECK(length(alternatives_json)<=12000), CHECK(length(consequences_json)<=12000)
);
CREATE INDEX IF NOT EXISTS idx_agent_escalations_task_state ON agent_escalation_packages(task_id,state,updated_at);
INSERT OR REPLACE INTO meta (key,value) VALUES ('agent_task_schema_version','4');
