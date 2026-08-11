"use strict";

/**
 * Module lifecycle repository (docs/module-system-design.md).
 *
 * Persists validated module manifests, lifecycle state transitions and module
 * migration progress on the `platform_modules` table so module state survives
 * process restarts. Storage is ensured through the existing schema mechanism
 * (migrations/029_platform_modules.sql and ensurePlatformModuleSchema — the
 * same SQL, kept byte-identical by the parity test).
 *
 * Migration progress and the accompanying lifecycle transition are recorded
 * inside the same transaction as the module's data migrations (via the
 * runner's recordProgress hook), so a module is never left with applied data
 * changes but unrecorded progress, or vice versa.
 *
 * This repository owns persistence only. Registration of module tools into
 * the live registry, dispatch, policy and approval all continue through the
 * existing single dispatcher/registry path — nothing here executes module
 * code.
 */

const crypto = require("crypto");
const dbStore = require("../db");
const { ensurePlatformModuleSchema } = require("./schema");
const { runModuleMigrations } = require("./migrations");
const {
  MODULE_STATES,
  MODULE_TRANSITIONS,
  normalizeManifest,
  validateModuleConfig,
} = require("./manifest");

// Lifecycle states that stamp a dedicated timestamp column on entry.
const STATE_TIMESTAMP_COLUMNS = Object.freeze({
  installed: "installed_at",
  configured: "configured_at",
  enabled: "enabled_at",
  disabled: "disabled_at",
  uninstalled: "uninstalled_at",
  healthy: "last_health_check_at",
});

function nowIso() {
  return new Date().toISOString();
}

function newModuleId() {
  return `mod_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function getDb() {
  return dbStore.getDb();
}

function ensureModuleStorage() {
  ensurePlatformModuleSchema();
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    ...row,
    manifest: parseJson(row.manifest_json, {}),
    config: parseJson(row.config_json, {}),
    applied_migrations: parseJson(row.applied_migrations_json, []),
    health: parseJson(row.health_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function getModule(name) {
  ensureModuleStorage();
  const row = getDb().prepare("SELECT * FROM platform_modules WHERE name = ?").get(String(name));
  return normalizeRow(row);
}

function listModules({ state } = {}) {
  ensureModuleStorage();
  if (state !== undefined) {
    if (!MODULE_STATES.includes(state)) throw new Error(`Invalid module state filter: ${state}`);
    return getDb()
      .prepare("SELECT * FROM platform_modules WHERE state = ? ORDER BY registered_at DESC")
      .all(state)
      .map(normalizeRow);
  }
  return getDb()
    .prepare("SELECT * FROM platform_modules ORDER BY registered_at DESC")
    .all()
    .map(normalizeRow);
}

/**
 * Persist a validated manifest for the first time. The manifest is normalized
 * (and therefore validated) here; the row starts in state "validated".
 * Registering a name that already exists fails closed — upgrades and
 * re-registration are a separate, explicit flow.
 */
function registerModule(manifestInput, { source = "discovered", entryPoint = null, entryHash = null, config } = {}) {
  ensureModuleStorage();
  const manifest = normalizeManifest(manifestInput);

  // Config is required only before enablement (configured/enabled), so an
  // unconfigured registration is valid; validate only when config is supplied.
  let storedConfig = {};
  if (config !== undefined) {
    const configResult = validateModuleConfig(manifest, config);
    if (!configResult.ok) {
      const details = (configResult.errors || []).map(e => `${e.path}: ${e.message}`).join("; ");
      throw new Error(`Module "${manifest.name}" config is invalid: ${details}`);
    }
    storedConfig = configResult.config;
  }

  const db = getDb();
  const existing = db.prepare("SELECT name, state FROM platform_modules WHERE name = ?").get(manifest.name);
  if (existing) {
    throw new Error(`Module "${manifest.name}" is already registered (state: ${existing.state})`);
  }

  const moduleId = newModuleId();
  db.prepare(`
    INSERT INTO platform_modules (
      module_id, name, version, state, type, author, description,
      manifest_json, config_json, source, entry_point, entry_hash, registered_at
    ) VALUES (?, ?, ?, 'validated', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    moduleId,
    manifest.name,
    manifest.version,
    manifest.type,
    manifest.author || null,
    manifest.description,
    JSON.stringify(manifest),
    JSON.stringify(storedConfig),
    source,
    entryPoint,
    entryHash,
    nowIso()
  );

  return getModule(manifest.name);
}

function bindEntryHash(name, entryHash) {
  ensureModuleStorage();
  if (!entryHash || !/^[a-f0-9]{64}$/i.test(String(entryHash))) throw new Error("entryHash must be a SHA-256 hex digest");
  const result = getDb().prepare("UPDATE platform_modules SET entry_hash = ? WHERE name = ? AND entry_hash IS NULL").run(String(entryHash).toLowerCase(), String(name));
  if (result.changes === 0) {
    const record = getModule(name);
    if (!record) throw new Error(`Module "${name}" is not registered`);
    if (record.entry_hash !== String(entryHash).toLowerCase()) throw new Error(`Module "${name}" entry binding already exists and does not match`);
  }
  return getModule(name);
}

/**
 * Best-effort kernel ledger event for a module lifecycle change. Never throws:
 * observability must not break (or roll back) the lifecycle operation itself.
 * Inside applyModuleMigrations this runs within the migration transaction, so
 * a recorded event commits or rolls back atomically with the transition.
 */
function recordTransitionEvent(moduleName, fromState, toState, { error = null, migrationsApplied = null } = {}) {
  try {
    require("../platform/kernel").appendEvent({
      event_type: "module.transition",
      source: "modules",
      subject_type: "module",
      subject_id: moduleName,
      severity: toState === "error" ? "warning" : "info",
      // Error strings are arbitrary text and are NOT redacted here; label the
      // event honestly so future event readers do not display it as safe.
      redaction_state: "none",
      payload: {
        module: moduleName,
        from: fromState,
        to: toState,
        error: error ? String(error).replace(/\s+/g, " ").slice(0, 300) : undefined,
        migrations_applied: migrationsApplied || undefined,
      },
    });
  } catch {}
}

function assertTransition(moduleName, fromState, toState) {
  if (!MODULE_STATES.includes(toState)) {
    throw new Error(`Invalid module state: ${toState}`);
  }
  const allowed = MODULE_TRANSITIONS[fromState] || [];
  if (!allowed.includes(toState)) {
    throw new Error(`Invalid module transition for "${moduleName}": ${fromState} -> ${toState}`);
  }
}

/**
 * Build the UPDATE fragment shared by transitionModule and the in-transaction
 * migration progress hook. The WHERE clause is guarded on the state observed
 * at read time; zero affected rows means a concurrent writer moved the module
 * and the caller must fail (and, inside a transaction, roll back).
 */
function buildTransitionUpdate(record, toState, { error = null, config = null } = {}) {
  const sets = ["state = ?"];
  const params = [toState];

  const timestampColumn = STATE_TIMESTAMP_COLUMNS[toState];
  if (timestampColumn) {
    sets.push(`${timestampColumn} = ?`);
    params.push(nowIso());
  }

  if (toState === "error") {
    sets.push("error = ?", "error_count = error_count + 1");
    params.push(error ? String(error) : "unknown module error");
  } else {
    sets.push("error = NULL");
  }

  if (config !== null) {
    const configResult = validateModuleConfig(record.manifest, config);
    if (!configResult.ok) {
      const details = (configResult.errors || []).map(e => `${e.path}: ${e.message}`).join("; ");
      throw new Error(`Module "${record.name}" config is invalid: ${details}`);
    }
    sets.push("config_json = ?");
    params.push(JSON.stringify(configResult.config));
  }

  return { sets, params };
}

/**
 * Persist a lifecycle state transition, validated against MODULE_TRANSITIONS.
 * Options: `error` (message for -> error transitions), `config` (validated and
 * persisted alongside the transition, e.g. installed -> configured).
 */
function transitionModule(name, toState, options = {}) {
  ensureModuleStorage();
  const record = getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  assertTransition(record.name, record.state, toState);

  const { sets, params } = buildTransitionUpdate(record, toState, options);
  const result = getDb()
    .prepare(`UPDATE platform_modules SET ${sets.join(", ")} WHERE module_id = ? AND state = ?`)
    .run(...params, record.module_id, record.state);
  if (result.changes === 0) {
    throw new Error(`Module "${name}" state changed concurrently (expected ${record.state})`);
  }
  recordTransitionEvent(record.name, record.state, toState, { error: options.error });

  return getModule(name);
}

/**
 * Apply the module's declared migrations (data-only, enforced by the runner)
 * and record progress — applied_migrations_json + migration_version — plus an
 * optional lifecycle transition, all inside the runner's single transaction.
 * If persistence fails the data migrations roll back with it; if a migration
 * fails nothing is recorded. Already-applied migrations are never re-run.
 */
function applyModuleMigrations(name, { transitionTo = null, error = null, config = null } = {}) {
  ensureModuleStorage();
  const record = getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (transitionTo !== null) assertTransition(record.name, record.state, transitionTo);

  const migrations = Array.isArray(record.manifest.migrations) ? record.manifest.migrations : [];
  const alreadyApplied = Array.isArray(record.applied_migrations) ? record.applied_migrations : [];
  const db = getDb();

  const pendingCount = migrations.filter(m => !alreadyApplied.includes(m.name)).length;
  if (pendingCount === 0) {
    // Nothing to apply; the transition (if any) is a plain single-statement
    // update and needs no surrounding data transaction.
    const module = transitionTo !== null ? transitionModule(name, transitionTo, { error, config }) : record;
    return { applied: [], alreadyApplied, module };
  }

  const result = runModuleMigrations(db, record.name, migrations, alreadyApplied, {
    recordProgress(progress) {
      const toState = transitionTo !== null ? transitionTo : record.state;
      const { sets, params } =
        transitionTo !== null
          ? buildTransitionUpdate(record, toState, { error, config })
          : { sets: [], params: [] };
      sets.push("applied_migrations_json = ?", "migration_version = ?");
      params.push(JSON.stringify(progress.alreadyApplied), progress.alreadyApplied.length);
      const update = db
        .prepare(`UPDATE platform_modules SET ${sets.join(", ")} WHERE module_id = ? AND state = ?`)
        .run(...params, record.module_id, record.state);
      if (update.changes === 0) {
        throw new Error(`Module "${record.name}" state changed concurrently (expected ${record.state})`);
      }
      recordTransitionEvent(record.name, record.state, toState, {
        error,
        migrationsApplied: progress.applied,
      });
    },
  });

  return { applied: result.applied, alreadyApplied: result.alreadyApplied, module: getModule(name) };
}

module.exports = {
  ensureModuleStorage,
  registerModule,
  bindEntryHash,
  getModule,
  listModules,
  transitionModule,
  applyModuleMigrations,
  STATE_TIMESTAMP_COLUMNS,
};
