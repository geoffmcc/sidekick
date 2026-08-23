-- Adaptive durable Agent v3.  All JSON is bounded at the database boundary;
-- model and tool text is metadata/evidence, never executable authority.
ALTER TABLE agent_tasks ADD COLUMN authority_envelope_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN authority_envelope_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_tasks ADD COLUMN usage_ledger_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN current_milestone TEXT;
ALTER TABLE agent_tasks ADD COLUMN active_work_package TEXT;
ALTER TABLE agent_tasks ADD COLUMN stopping_reason TEXT;
CREATE TABLE IF NOT EXISTS agent_operation_receipts (
  receipt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
  action_fingerprint TEXT NOT NULL, capability TEXT NOT NULL, capability_version TEXT,
  argument_digest TEXT NOT NULL, target_ref TEXT, project_ref TEXT, workspace_ref TEXT,
  risk_class TEXT NOT NULL, effect_class TEXT NOT NULL, idempotency_class TEXT NOT NULL,
  reversibility_class TEXT NOT NULL, preconditions_json TEXT NOT NULL DEFAULT '{}',
  dispatch_state TEXT NOT NULL, dispatched_at TEXT, finalized_at TEXT,
  provider_receipt_ref TEXT, expected_postconditions_json TEXT NOT NULL DEFAULT '[]',
  verification_recipe_ref TEXT, rollback_recipe_ref TEXT, outcome_state TEXT NOT NULL,
  principal_ref TEXT, policy_ref TEXT, approval_ref TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  CHECK(length(preconditions_json)<=20000), CHECK(length(expected_postconditions_json)<=20000)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_receipt_task_fingerprint ON agent_operation_receipts(task_id, action_fingerprint);
CREATE INDEX IF NOT EXISTS idx_agent_receipt_state ON agent_operation_receipts(task_id, outcome_state, updated_at);
CREATE TABLE IF NOT EXISTS agent_verification_recipes (
  recipe_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
  requirement_id TEXT NOT NULL, check_type TEXT NOT NULL, capability TEXT NOT NULL,
  arguments_json TEXT NOT NULL DEFAULT '{}', expected_json TEXT NOT NULL DEFAULT '{}',
  freshness_ms INTEGER NOT NULL, independent INTEGER NOT NULL, timeout_ms INTEGER NOT NULL,
  retry_policy_json TEXT NOT NULL DEFAULT '{}', failure_classification TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  CHECK(length(arguments_json)<=12000), CHECK(length(expected_json)<=12000)
);
CREATE TABLE IF NOT EXISTS agent_verification_outcomes (
  outcome_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, task_id TEXT NOT NULL,
  evidence_ref TEXT, freshness_state TEXT NOT NULL, independence_state TEXT NOT NULL,
  observation_state TEXT NOT NULL, summary TEXT NOT NULL, observed_at TEXT NOT NULL,
  FOREIGN KEY(recipe_id) REFERENCES agent_verification_recipes(recipe_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_repair_attempts (
  repair_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, plan_revision INTEGER,
  step_id TEXT, failure_class TEXT NOT NULL, capability TEXT, argument_digest TEXT,
  retry_decision TEXT NOT NULL, policy_basis TEXT NOT NULL, changed_condition_ref TEXT,
  strategy TEXT NOT NULL, resulting_revision INTEGER, final_result TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_work_packages (
  package_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_package_id TEXT,
  package_key TEXT NOT NULL, state TEXT NOT NULL, mutation_target TEXT,
  lease_owner TEXT, lease_expires_at TEXT, result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  CHECK(length(result_json)<=30000)
);
CREATE INDEX IF NOT EXISTS idx_agent_work_packages_task_state ON agent_work_packages(task_id, state, updated_at);
CREATE TABLE IF NOT EXISTS agent_learning_candidates (
  candidate_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, kind TEXT NOT NULL,
  source_task_id TEXT, provenance_json TEXT NOT NULL DEFAULT '{}', proposal_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposal', evaluation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(source_task_id) REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  CHECK(length(provenance_json)<=12000), CHECK(length(proposal_json)<=20000), CHECK(length(evaluation_json)<=20000)
);
CREATE INDEX IF NOT EXISTS idx_agent_learning_candidates_project_state
  ON agent_learning_candidates(project_ref, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_learning_candidates_source
  ON agent_learning_candidates(source_task_id);
INSERT OR REPLACE INTO meta (key,value) VALUES ('agent_task_schema_version','3');
