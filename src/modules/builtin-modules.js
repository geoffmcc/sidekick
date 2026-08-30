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
const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");

const BUILTIN_MODULES = Object.freeze([require("./entries/data-utilities")]);

// Committed, signed attestation of each builtin's expected entry-code hash.
//
// This is the independent anchor that lets a builtin's entry hash be re-bound
// safely (see the drift branch in provisionBuiltinModules). A legitimate
// release that changes a builtin entry file updates BOTH the file and its hash
// here in the same signed commit — the test suite asserts they stay in lockstep
// (test/modules-entry-rebind.test.js), so forgetting to update this fails CI
// rather than silently disabling the module on deploy. Because the attestation
// lives in this separate file, an out-of-band change to only the entry file on
// disk produces a hash matching neither the stored binding nor this constant,
// so the module correctly fails closed (tamper-evident) instead of being
// re-bound to attacker-controlled bytes.
const EXPECTED_ENTRY_HASHES = Object.freeze({
  "data-utilities": "04a9fd55f42c9c026a0e8f32ddc7b75547fc85e8e79520e3acd944bd37bc0cf0",
});

function entryPointFor(name) {
  return `src/modules/entries/${name}.js`;
}

function entryHashFor(entryPoint) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.resolve(REPOSITORY_ROOT, entryPoint))).digest("hex");
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
  const alerts = [];

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
      } else if (record.source === "builtin") {
        // A shipped builtin's entry code can legitimately change across releases
        // (e.g. #217 added a healthCheck to data-utilities), changing its hash.
        // The registered hash is write-once, so without this the module fails
        // closed into `error` forever after any such release. Re-bind ONLY when
        // the on-disk entry matches this build's committed expected hash — the
        // independent, signed attestation above. That preserves the fail-closed
        // property: an on-disk entry that matches neither the stored binding nor
        // the committed hash is treated as tampering and left in error, never
        // re-bound. rebindBuiltinEntry additionally refuses non-builtin modules.
        const entryPoint = record.entry_point || entryPointFor(name);
        const currentHash = entryHashFor(entryPoint);
        const expected = EXPECTED_ENTRY_HASHES[name];
        if (record.entry_hash !== currentHash && expected && currentHash === expected) {
          record = repository.rebindBuiltinEntry(name, { entryPoint, entryHash: currentHash });
        }
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

  // Restore any other persisted enabled module — builtin OR installed
  // third-party. Managed modules are loaded through the verified entry loader,
  // so a package that fails integrity, compatibility or configuration is
  // reported here and simply does not run; it is never required blindly.
  // A missing/unloadable entry is a process-local condition, not a module
  // fault, so it never persists a global error transition.
  const { entries: allEntries, failures } = require("./entries").moduleEntriesByName();
  for (const failure of failures) {
    errors.push({ name: failure.name, error: `${failure.code}: ${failure.error}` });
    console.error(`[Modules] Failed to load installed module "${failure.name}": ${failure.error}`);
  }
  const restore = loader.restorePersistedModules(allEntries);
  for (const failure of restore.failed) {
    errors.push(failure);
    console.error(`[Modules] Failed to restore module "${failure.name}": ${failure.error}`);
  }

  const outcome = { provisioned, restored: restore.restored, skipped, errors };
  recordProvisioningEvent(outcome);
  return outcome;
}

/**
 * Periodic health sweep across ALL runnable modules.
 *
 * Not just builtins: an installed third-party (pack-owned) module is exactly
 * the kind of module whose health an operator needs swept, since its code came
 * from outside the release and its managed package can drift. Modules that are
 * not active in this process are skipped rather than loaded — the sweep must
 * not become a reason to execute code the operator disabled.
 */
function runModuleHealthChecks() {
  const checked = [];
  const skipped = [];
  const errors = [];
  const alerts = [];
  const { checkModuleHealth } = require("./health");
  const loaderModule = require("./loader");
  const { resolveModuleEntry } = require("./entries");

  for (const record of repository.listModules()) {
    const name = record.name;
    if (record.state !== "enabled" && record.state !== "healthy") {
      skipped.push({ name, state: record.state });
      continue;
    }
    if (!loaderModule.isModuleActive(name)) {
      skipped.push({ name, state: record.state, reason: "not active in this process" });
      continue;
    }
    const resolved = resolveModuleEntry(record);
    if (!resolved.ok) {
      errors.push({ name, error: resolved.error });
      continue;
    }
    if (typeof resolved.entry.healthCheck !== "function") {
      skipped.push({ name, state: record.state, reason: "no healthCheck" });
      continue;
    }
    try {
      const result = checkModuleHealth(name, resolved.entry);
      checked.push({ name, result });
      if (!result.ok) alerts.push({ name, health: result.health, state: result.module.state });
    } catch (error) {
      errors.push({ name, error: error.message });
    }
  }
  if (alerts.length) {
    try {
      require("../platform/kernel").appendEvent({
        event_type: "module.health.alert",
        source: "modules",
        subject_type: "module",
        subject_id: alerts[0].name,
        severity: "warning",
        redaction_state: "none",
        payload: { alerts },
      });
    } catch {}
  }
  return { checked, skipped, errors, alerts };
}

function startModuleHealthChecks(intervalMs = 60000) {
  const timer = setInterval(() => {
    const result = runModuleHealthChecks();
    if (result.errors.length) console.error(`[Modules] Health sweep failed: ${JSON.stringify(result.errors)}`);
    if (result.alerts.length) console.error(`[Modules] Health alerts: ${JSON.stringify(result.alerts)}`);
  }, intervalMs);
  timer.unref?.();
  return timer;
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
      const result = loader.reconcilePersistedModules(require("./entries").moduleEntriesByName().entries);
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

module.exports = {
  BUILTIN_MODULES,
  EXPECTED_ENTRY_HASHES,
  entryPointFor,
  builtinEntriesByName,
  provisionBuiltinModules,
  runModuleHealthChecks,
  // Compatibility alias: the sweep now covers installed modules too, but the
  // original name is on the public surface.
  runBuiltinModuleHealthChecks: runModuleHealthChecks,
  startModuleHealthChecks,
  startModuleReconciliation,
};
