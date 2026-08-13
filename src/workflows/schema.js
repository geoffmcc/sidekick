"use strict";

// Workflow DEFINITION registry schema (docs/capability-packs.md).
//
// Sidekick already owns workflow EXECUTION state (platform_workflows,
// platform_workflow_steps) and the execution ledger. What it lacked was a
// durable place for reusable workflow DEFINITIONS, which is why capability
// packs could not contribute runnable workflows without inventing a second
// engine. This table is that missing half; the runner in ./runner.js executes
// definitions through the existing kernel workflow primitives and the single
// tool dispatcher.
//
// Must stay byte-identical (up to whitespace) to the workflow-definition
// section of migrations/036_capability_packs.sql.

const WORKFLOW_DEFINITION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS platform_workflow_definitions (
  definition_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  title TEXT,
  description TEXT,
  owner_kind TEXT NOT NULL DEFAULT 'core',
  owner_name TEXT,
  state TEXT NOT NULL DEFAULT 'registered',
  mode TEXT NOT NULL DEFAULT 'read_only',
  definition_json TEXT NOT NULL DEFAULT '{}',
  checksum TEXT,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_workflow_definitions_name ON platform_workflow_definitions(name);
CREATE INDEX IF NOT EXISTS idx_platform_workflow_definitions_owner ON platform_workflow_definitions(owner_kind, owner_name);
CREATE INDEX IF NOT EXISTS idx_platform_workflow_definitions_state ON platform_workflow_definitions(state, name);
`;

let ensured = false;

function ensureWorkflowDefinitionSchema() {
  if (ensured) return;
  require("../db").getDb().exec(WORKFLOW_DEFINITION_SCHEMA_SQL);
  ensured = true;
}

module.exports = { WORKFLOW_DEFINITION_SCHEMA_SQL, ensureWorkflowDefinitionSchema };
