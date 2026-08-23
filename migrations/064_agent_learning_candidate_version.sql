-- Durable version identity for reviewable learning proposals.
ALTER TABLE agent_learning_candidates ADD COLUMN candidate_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_agent_learning_candidates_version ON agent_learning_candidates(project_ref, candidate_version, updated_at);
