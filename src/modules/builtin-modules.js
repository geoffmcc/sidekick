"use strict";

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
        repository.registerModule(builtin.MANIFEST, {
          source: "builtin",
          entryPoint: `src/modules/entries/${name}.js`,
        });
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
  // this process fail closed to the error state inside the loader.
  const restore = loader.restorePersistedModules(builtinEntriesByName());
  for (const failure of restore.failed) {
    errors.push(failure);
    console.error(`[Modules] Failed to restore module "${failure.name}": ${failure.error}`);
  }

  return { provisioned, restored: restore.restored, skipped, errors };
}

module.exports = { BUILTIN_MODULES, builtinEntriesByName, provisionBuiltinModules };
