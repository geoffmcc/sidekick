-- Tool Registry Schema
-- This migration creates tables for managing tool metadata, categories, and knowledge base

-- Tool categories (e.g., Core, Storage, Database, etc.)
CREATE TABLE IF NOT EXISTS tool_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  icon TEXT NOT NULL DEFAULT 'fa-puzzle-piece',
  sort_order INTEGER NOT NULL DEFAULT 999,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tool registry with metadata
CREATE TABLE IF NOT EXISTS tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  args_json TEXT,
  risk TEXT NOT NULL DEFAULT 'low',
  enabled INTEGER NOT NULL DEFAULT 1,
  deprecated INTEGER NOT NULL DEFAULT 0,
  version_added TEXT,
  documentation_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Junction table for tool-category mapping (supports multi-category if needed)
CREATE TABLE IF NOT EXISTS tool_category_map (
  tool_name TEXT NOT NULL REFERENCES tools(name) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES tool_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (tool_name, category_id)
);

-- Knowledge base for storing contextual information
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  version_added TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for knowledge search
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_title ON knowledge(title);

-- Seed tool categories with current dashboard categories
INSERT OR IGNORE INTO tool_categories (name, icon, sort_order) VALUES
  ('Core', 'fa-terminal', 1),
  ('Storage', 'fa-database', 2),
  ('Database', 'fa-database', 3),
  ('Git & GitHub', 'fa-code-branch', 4),
  ('Services', 'fa-cogs', 5),
  ('Scheduling', 'fa-clock', 6),
  ('Communication', 'fa-bell', 7),
  ('Context & Learning', 'fa-brain', 8),
  ('Data Pipeline', 'fa-filter', 9),
  ('Monitoring', 'fa-heartbeat', 10),
  ('Workflow', 'fa-tasks', 11),
  ('Meta', 'fa-robot', 12),
  ('Efficiency', 'fa-bolt', 13),
  ('Security', 'fa-shield-alt', 14),
  ('Networking', 'fa-network-wired', 15),
  ('Development', 'fa-code', 16),
  ('Reliability', 'fa-plug', 17),
  ('Archive', 'fa-file-archive', 18),
  ('Media', 'fa-film', 19);

-- Update schema version
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');
