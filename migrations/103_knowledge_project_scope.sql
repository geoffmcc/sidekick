-- Keep curated packaged knowledge global while allowing user-authored entries
-- to follow the same project membership boundary as persistent memory.
ALTER TABLE knowledge ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_project_enabled_updated
  ON knowledge(project_id, enabled, updated_at DESC);

INSERT OR IGNORE INTO identity_permissions (permission, description, risk, created_at) VALUES
  ('knowledge.read', 'Read global or authorized project knowledge', 'medium', datetime('now')),
  ('knowledge.write', 'Create or modify global or authorized project knowledge', 'high', datetime('now'));

INSERT OR IGNORE INTO identity_role_permissions (role_name, permission, assigned_at) VALUES
  ('owner', 'knowledge.read', datetime('now')),
  ('owner', 'knowledge.write', datetime('now')),
  ('administrator', 'knowledge.read', datetime('now')),
  ('administrator', 'knowledge.write', datetime('now')),
  ('operator', 'knowledge.read', datetime('now')),
  ('operator', 'knowledge.write', datetime('now')),
  ('viewer', 'knowledge.read', datetime('now'));
