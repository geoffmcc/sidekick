"use strict";

/**
 * Workflow definition repository.
 *
 * Persists reusable workflow definitions and their ownership. Execution state
 * is NOT stored here — that stays in platform_workflows / platform_workflow_steps
 * and the execution ledger, which already own durable run state, checkpoints
 * and history. This table answers only "which workflows exist, what do they
 * do, and who owns them".
 */

const crypto = require("crypto");
const dbStore = require("../db");
const { ensureWorkflowDefinitionSchema } = require("./schema");
const { normalizeDefinition, definitionChecksum } = require("./definition");

const OWNER_KINDS = Object.freeze(["core", "pack"]);
const STATES = Object.freeze(["registered", "disabled"]);

function nowIso() {
  return new Date().toISOString();
}

function getDb() {
  return dbStore.getDb();
}

function ensureStorage() {
  ensureWorkflowDefinitionSchema();
}

function normalizeRow(row) {
  if (!row) return null;
  let definition = {};
  try {
    definition = JSON.parse(row.definition_json);
  } catch {}
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {}
  return { ...row, definition, metadata };
}

function getWorkflowDefinition(name) {
  ensureStorage();
  return normalizeRow(getDb().prepare("SELECT * FROM platform_workflow_definitions WHERE name = ?").get(String(name)));
}

function listWorkflowDefinitions({ ownerKind, ownerName, state } = {}) {
  ensureStorage();
  const clauses = [];
  const params = [];
  if (ownerKind) {
    clauses.push("owner_kind = ?");
    params.push(String(ownerKind));
  }
  if (ownerName) {
    clauses.push("owner_name = ?");
    params.push(String(ownerName));
  }
  if (state) {
    if (!STATES.includes(state)) throw new Error(`Invalid workflow definition state filter: ${state}`);
    clauses.push("state = ?");
    params.push(state);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT * FROM platform_workflow_definitions${where} ORDER BY name ASC`)
    .all(...params)
    .map(normalizeRow);
}

/**
 * Register or replace a definition.
 *
 * Ownership is enforced: a pack may not silently take over a definition that
 * another owner registered. Re-registering the same name with the same owner
 * REPLACES the definition (this is how pack upgrades update their workflows)
 * and keeps the original registration timestamp.
 */
function registerWorkflowDefinition(input, { ownerKind = "core", ownerName = null, metadata = {} } = {}) {
  ensureStorage();
  if (!OWNER_KINDS.includes(ownerKind)) throw new Error(`Invalid workflow owner kind: ${ownerKind}`);
  if (ownerKind === "pack" && !ownerName) throw new Error("A pack-owned workflow definition requires an owner name");

  const definition = normalizeDefinition(input);
  const existing = getWorkflowDefinition(definition.name);
  if (existing && (existing.owner_kind !== ownerKind || (existing.owner_name || null) !== (ownerName || null))) {
    throw new Error(
      `Workflow "${definition.name}" is already owned by ${existing.owner_kind}${existing.owner_name ? `:${existing.owner_name}` : ""}`
    );
  }

  const checksum = definitionChecksum(definition);
  const ts = nowIso();
  if (existing) {
    getDb().prepare(`
      UPDATE platform_workflow_definitions
      SET version = ?, title = ?, description = ?, mode = ?, definition_json = ?, checksum = ?,
          state = 'registered', updated_at = ?, metadata_json = ?
      WHERE definition_id = ?
    `).run(
      definition.version,
      definition.title,
      definition.description,
      definition.mode,
      JSON.stringify(definition),
      checksum,
      ts,
      JSON.stringify(metadata),
      existing.definition_id
    );
    return getWorkflowDefinition(definition.name);
  }

  const definitionId = `wfd_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
  getDb().prepare(`
    INSERT INTO platform_workflow_definitions (
      definition_id, name, version, title, description, owner_kind, owner_name,
      state, mode, definition_json, checksum, registered_at, updated_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?)
  `).run(
    definitionId,
    definition.name,
    definition.version,
    definition.title,
    definition.description,
    ownerKind,
    ownerName,
    definition.mode,
    JSON.stringify(definition),
    checksum,
    ts,
    ts,
    JSON.stringify(metadata)
  );
  return getWorkflowDefinition(definition.name);
}

/**
 * Mark a definition unavailable without deleting it.
 *
 * Disabling a pack must make its workflows un-runnable, but the definitions
 * are the reference for any historical run, so they are parked rather than
 * destroyed.
 */
function setWorkflowDefinitionState(name, state) {
  ensureStorage();
  if (!STATES.includes(state)) throw new Error(`Invalid workflow definition state: ${state}`);
  const record = getWorkflowDefinition(name);
  if (!record) throw new Error(`Workflow "${name}" is not registered`);
  getDb()
    .prepare("UPDATE platform_workflow_definitions SET state = ?, updated_at = ? WHERE definition_id = ?")
    .run(state, nowIso(), record.definition_id);
  return getWorkflowDefinition(name);
}

function setOwnerState(ownerKind, ownerName, state) {
  const affected = [];
  for (const record of listWorkflowDefinitions({ ownerKind, ownerName })) {
    affected.push(setWorkflowDefinitionState(record.name, state));
  }
  return affected;
}

/** Remove a definition. Historical runs in the kernel ledger are untouched. */
function removeWorkflowDefinition(name) {
  ensureStorage();
  const record = getWorkflowDefinition(name);
  if (!record) return { removed: false };
  getDb().prepare("DELETE FROM platform_workflow_definitions WHERE definition_id = ?").run(record.definition_id);
  return { removed: true, definition: record };
}

module.exports = {
  OWNER_KINDS,
  STATES,
  ensureStorage,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  registerWorkflowDefinition,
  setWorkflowDefinitionState,
  setOwnerState,
  removeWorkflowDefinition,
};
