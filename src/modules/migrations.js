"use strict";

/**
 * Module migration runner (docs/module-system-design.md).
 *
 * Modules may run migrations against the platform database, but only within
 * strict bounds:
 *   - Migrations run in declaration order inside a single transaction.
 *   - A migration that already applied (by name) is skipped.
 *   - Module migrations must NOT create or destroy schema objects. Module
 *     migrations may only mutate data in published platform tables. Any DDL
 *     (CREATE/DROP/ALTER TABLE, INDEX, VIEW, TRIGGER, RENAME) fails closed and
 *     aborts the whole batch, leaving the module in a safe un-applied state.
 *   - Progress is persisted on `platform_modules` (migration_version +
 *     applied_migrations_json), and the module is never re-activated with a
 *     partially applied migration set.
 */

const PUBLISHED_PLATFORM_PREFIX = "platform_";
const FORBIDDEN_STATEMENTS = [
  /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\b/i,
  /^\s*DROP\s+TABLE\b/i,
  /^\s*ALTER\s+TABLE\b/i,
  /^\s*RENAME\s+TO\b/i,
  /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:UNIQUE\s+)?INDEX\b/i,
  /^\s*DROP\s+INDEX\b/i,
  /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?VIEW\b/i,
  /^\s*DROP\s+VIEW\b/i,
  /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i,
  /^\s*DROP\s+TRIGGER\b/i,
  /^\s*PRAGMA\b/i,
  /^\s*VACUUM\b/i,
  /^\s*ATTACH\b/i,
  /^\s*DETACH\b/i,
];

function splitStatements(sql) {
  const statements = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inBlock = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inSingle) {
      if (c === "'") { if (next === "'") { i++; } else { inSingle = false; } }
      continue;
    }
    if (inDouble) {
      if (c === '"') { if (next === '"') { i++; } else { inDouble = false; } }
      continue;
    }
    if (inBacktick) {
      if (c === "`") inBacktick = false;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "`") { inBacktick = true; continue; }
    if (c === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function assertMigrationIsDataOnly(sql) {
  for (const statement of splitStatements(sql)) {
    for (const forbidden of FORBIDDEN_STATEMENTS) {
      if (forbidden.test(statement)) {
        throw new Error(
          `Module migration contains a forbidden statement (module migrations may only mutate data in published platform_* tables): ${statement.slice(0, 120)}`
        );
      }
    }
    if (!/^SELECT\b|^INSERT\b|^UPDATE\b|^DELETE\b|^WITH\b/i.test(statement)) {
      throw new Error(`Module migration contains an unsupported statement: ${statement.slice(0, 120)}`);
    }
    const cteNames = new Set([...statement.matchAll(/(?:\bWITH|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi)].map(match => match[1].toLowerCase()));
    const tableReferences = [...statement.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(["`]?)([A-Za-z_][A-Za-z0-9_]*)(?:\1)/gi)]
      .map(match => match[2])
      .filter(table => !cteNames.has(table.toLowerCase()));
    const privateTable = tableReferences.find(table => !table.startsWith(PUBLISHED_PLATFORM_PREFIX));
    if (privateTable) {
      throw new Error(`Module migration may only mutate published platform_* tables: ${privateTable}`);
    }
  }
}

/**
 * Apply a module's migration set.
 *
 * @param {object} db - the platform database handle
 * @param {string} moduleName - module name (for error messages + progress)
 * @param {Array<{name: string, sql: string}>} migrations - declared migrations
 * @param {string[]} alreadyApplied - names already applied (from the row)
 * @param {object} [options]
 * @param {function} [options.recordProgress] - called inside the transaction
 *   after all pending migrations execute, with { applied, alreadyApplied }.
 *   If it throws, the whole batch (data changes included) rolls back, so
 *   migration data and persisted progress commit or fail as one unit.
 * @returns {{ applied: string[], alreadyApplied: string[] }}
 */
function runModuleMigrations(db, moduleName, migrations, alreadyApplied = [], options = {}) {
  const applied = [];
  const appliedSet = new Set(alreadyApplied || []);
  const pending = (migrations || []).filter(m => !appliedSet.has(m.name));

  if (pending.length === 0) {
    return { applied: [], alreadyApplied: [...appliedSet] };
  }

  for (const migration of pending) {
    assertMigrationIsDataOnly(migration.sql);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      applied.push(migration.name);
    }
    if (typeof options.recordProgress === "function") {
      options.recordProgress({ applied: [...applied], alreadyApplied: [...appliedSet, ...applied] });
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new Error(`Module "${moduleName}" migration batch failed: ${error.message}`);
  }

  return { applied, alreadyApplied: [...appliedSet, ...applied] };
}

module.exports = { runModuleMigrations, splitStatements, assertMigrationIsDataOnly };
