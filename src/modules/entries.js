"use strict";

/**
 * Module entry resolution across BOTH module sources (B9).
 *
 * Before B9 the only entries a process could obtain were the builtin ones
 * compiled into the repository, which is why an installed third-party module
 * could be persisted as `enabled` yet never actually run anywhere. Entry
 * resolution now covers both:
 *
 *   - builtin modules  -> the in-repo entry object (trusted, ships with the
 *                         signed release, hash-attested in builtin-modules.js)
 *   - managed modules  -> loaded from the managed store through the verified
 *                         entry loader, which refuses to require anything that
 *                         fails integrity, compatibility or configuration
 *
 * Resolution is deliberately best-effort per module: one module that cannot be
 * loaded must not stop every other module from being restored, and a load
 * failure is process-local information, not a reason to fail the module
 * globally.
 */

const repository = require("./repository");
const entryLoader = require("./entry-loader");

const RUNNABLE_STATES = new Set(["enabled", "healthy"]);

function builtinEntries() {
  // Lazy: builtin-modules requires the loader, which requires this file's
  // siblings. Resolving late keeps the boot-time require graph acyclic.
  return require("./builtin-modules").builtinEntriesByName();
}

/**
 * Resolve one module's entry, or return a structured failure.
 * Never throws — callers decide how a failure is reported.
 */
function resolveModuleEntry(record) {
  if (!record) return { ok: false, code: "unregistered", error: "Module is not registered" };
  const builtin = builtinEntries()[record.name];
  if (builtin) return { ok: true, entry: builtin, kind: "builtin" };
  if (!entryLoader.isManagedRecord(record)) {
    return { ok: false, code: "no_entry", error: `Module "${record.name}" has no entry available in this process` };
  }
  try {
    return { ok: true, entry: entryLoader.loadInstalledModuleEntry(record), kind: "managed" };
  } catch (error) {
    return { ok: false, code: error.code || entryLoader.LOAD_FAILURES.LOAD_FAILURE, error: error.message };
  }
}

/**
 * Entry map for the loader's restore/reconcile passes: builtin entries plus
 * every managed module currently in a runnable state.
 *
 * Modules that are not runnable are NOT loaded. Executing the code of a
 * disabled or error-state module just to build a map would defeat the point of
 * the lifecycle.
 */
function moduleEntriesByName({ includeManaged = true } = {}) {
  const entries = { ...builtinEntries() };
  const failures = [];
  if (!includeManaged) return { entries, failures };
  let records = [];
  try {
    records = repository.listModules();
  } catch {
    return { entries, failures };
  }
  for (const record of records) {
    if (entries[record.name]) continue;
    if (!RUNNABLE_STATES.has(record.state)) continue;
    if (!entryLoader.isManagedRecord(record)) continue;
    const resolved = resolveModuleEntry(record);
    if (resolved.ok) entries[record.name] = resolved.entry;
    else failures.push({ name: record.name, code: resolved.code, error: resolved.error });
  }
  return { entries, failures };
}

module.exports = { RUNNABLE_STATES, resolveModuleEntry, moduleEntriesByName };
