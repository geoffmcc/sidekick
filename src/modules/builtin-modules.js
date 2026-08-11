"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * Builtin module provisioning (docs/module-system-design.md).
 *
 * Each Sidekick process (MCP server, agent, dashboard) calls
 * provisionBuiltinModules() at startup, after database migrations:
 *
 *   - A builtin module that has never been registered is registered,
 *     installed (running its migrations, if any) and enabled.
 *   - A persisted enabled/healthy module is re-activated in this process
 *     (restorePersistedModules), so module tools survive restarts.
 *   - A module the operator moved to disabled/error/uninstalling/uninstalled
 *     is left alone — provisioning never overrides operator intent.
 *
 * A module that fails to provision is reported (and recorded on its row via
 * the loader's fail-closed error transition) but does not abort startup: the
 * process boots without that module's tools rather than not at all.
 */

const repository = require("./repository");
const loader = require("./loader");

const BUILTIN_MODULES = Object.freeze([require("./entries/data-utilities")]);

function entryPointFor(name) {
  return `src/modules/entries/${name}.js`;
}

function entryHashFor(entryPoint) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.resolve(process.cwd(), entryPoint))).digest("hex");
}

function builtinEntriesByName() {
  const entries = {};
  for (const builtin of BUILTIN_MODULES) entries[builtin.MANIFEST.name] = builtin.entry;
  return entries;
}

function provisionBuiltinModules() {
  const provisioned = [];
  const skipped = [];
  const errors = [];

  for (const builtin of BUILTIN_MODULES) {
    const name = builtin.MANIFEST.name;
    try {
      let record = repository.getModule(name);
      if (!record) {
        const entryPoint = entryPointFor(name);
        repository.registerModule(builtin.MANIFEST, {
          source: "builtin",
          entryPoint,
          entryHash: entryHashFor(entryPoint),
        });
        record = repository.getModule(name);
      } else if (!record.entry_hash) {
        repository.bindEntryHash(name, entryHashFor(record.entry_point || entryPointFor(name)));
        record = repository.getModule(name);
      }
      if (record.state === "validated" || record.state === "installed") {
        // Transient bootstrap states, not operator intent: a crash (or a
        // concurrent process losing the registration race) between register
        // and enable must not strand the module forever. Resumption is safe
        // under concurrency — the repository's state-guarded transitions make
        // the loser fail, and the error is reported below.
        if (record.state === "validated") {
          repository.applyModuleMigrations(name, { transitionTo: "installed" });
        }
        loader.enableModule(name, builtin.entry);
        provisioned.push({ name, action: "registered" });
      } else if (record.state === "enabled" || record.state === "healthy") {
        loader.enableModule(name, builtin.entry);
        provisioned.push({ name, action: "restored" });
      } else {
        // disabled / error / uninstalling / uninstalled / configured are
        // operator (or fault) states that provisioning never overrides.
        skipped.push({ name, state: record.state });
        console.log(`[Modules] Skipping builtin module "${name}" in state ${record.state} (operator intent preserved)`);
      }
    } catch (error) {
      errors.push({ name, error: error.message });
      console.error(`[Modules] Failed to provision builtin module "${name}": ${error.message}`);
    }
  }

  // Restore any other persisted enabled modules. Ones without an entry in
  // this process are reported as failed here (and flagged by the modules
  // health check) but keep their persisted state — a missing entry is a
  // process-local condition, not a module fault.
  const restore = loader.restorePersistedModules(builtinEntriesByName());
  for (const failure of restore.failed) {
    errors.push(failure);
    console.error(`[Modules] Failed to restore module "${failure.name}": ${failure.error}`);
  }

  const outcome = { provisioned, restored: restore.restored, skipped, errors };
  recordProvisioningEvent(outcome);
  return outcome;
}

/**
 * Best-effort kernel ledger event for a provisioning run. Never throws:
 * observability must not stop a process from booting.
 */
function recordProvisioningEvent(outcome) {
  try {
    require("../platform/kernel").appendEvent({
      event_type: "module.provisioning",
      source: "modules",
      subject_type: "process",
      subject_id: `pid:${process.pid}`,
      severity: outcome.errors.length ? "warning" : "info",
      // Error strings are arbitrary text and are NOT redacted here; label the
      // event honestly so future event readers do not display it as safe.
      redaction_state: "none",
      payload: {
        ...outcome,
        errors: outcome.errors.map(e => ({ ...e, error: String(e.error).replace(/\s+/g, " ").slice(0, 300) })),
      },
    });
  } catch {}
}

/**
 * Periodically reconcile this process's live module registrations with the
 * persisted lifecycle states, so enable/disable in another process converges
 * here without a restart (the dispatcher's per-call gate already fail-closes
 * disabled modules immediately; this timer also picks up re-enables).
 */
function startModuleReconciliation(intervalMs = 60000) {
  const timer = setInterval(() => {
    try {
      const result = loader.reconcilePersistedModules(builtinEntriesByName());
      if (result.deactivated.length || result.activated.length) {
        console.log(`[Modules] Reconciled: deactivated ${JSON.stringify(result.deactivated)}, activated ${JSON.stringify(result.activated)}`);
      }
      for (const failure of result.failed) {
        console.error(`[Modules] Reconciliation failed for "${failure.name}": ${failure.error}`);
      }
    } catch (error) {
      console.error("[Modules] Reconciliation error:", error.message);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { BUILTIN_MODULES, builtinEntriesByName, provisionBuiltinModules, startModuleReconciliation };
