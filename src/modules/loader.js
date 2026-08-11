"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * Module loader -> registry wiring (docs/module-system-design.md).
 *
 * Activates enabled modules by contributing their tool descriptors to the
 * EXISTING builtin registry path. There is no module registry: the loader
 * keeps an in-process map of active descriptor lists which
 * buildBuiltinRegistry appends when it assembles the one registry the
 * dispatcher already rebuilds per dispatch, so duplicate names and aliases
 * fail closed under the registry's own rules (plus checkManifestOwnership
 * for friendlier errors before activation).
 *
 * Module handlers are constructed against the frozen v1 service facade
 * (createModuleServices) — never the database, transports, or handler maps —
 * and any tool calls they make go through the single dispatcher with the full
 * policy + approval path. Activation mismatches (ownership conflicts,
 * descriptor/manifest divergence, invalid config) fail closed: the module is
 * transitioned to the `error` lifecycle state and nothing is registered.
 *
 * The module entry is pure behavior supplied by the caller (for now, in-repo
 * code; discovery/packaging is a later slice): an object exposing
 * `buildDescriptors(servicesV1)` returning tool descriptors in the existing
 * descriptor shape (name, description, schema, risk, category, aliases,
 * handler).
 */

const { normalizeDescriptor } = require("../tools/descriptor");
const { stripSidekickPrefix } = require("../core/tool-name");
const repository = require("./repository");
const { createModuleServices } = require("./services");
const {
  MODULE_TRANSITIONS,
  validateModuleConfig,
  checkManifestOwnership,
  verifyModuleTools,
} = require("./manifest");

// moduleName -> frozen array of normalized descriptors currently registered.
const activeModules = new Map();

function freezeDeep(value) {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function getActiveDescriptors() {
  return [...activeModules.values()].flat();
}

function getActiveModuleNames() {
  return [...activeModules.keys()];
}

function isModuleActive(name) {
  return activeModules.has(String(name));
}

/**
 * Resolve an active module tool descriptor by canonical name or alias, or
 * null. Used by the legacy risk lookup so policy/approval enforcement sees
 * the risk of the descriptor that actually dispatches for the name.
 */
function resolveActiveDescriptor(name) {
  const canonical = stripSidekickPrefix(String(name || ""));
  for (const descriptors of activeModules.values()) {
    for (const descriptor of descriptors) {
      if (stripSidekickPrefix(descriptor.name) === canonical) return descriptor;
      for (const alias of descriptor.aliases || []) {
        if (stripSidekickPrefix(alias) === canonical) return descriptor;
      }
    }
  }
  return null;
}

function liveRegistrySnapshot() {
  // Lazy require: the registry builder requires this module, so the loader
  // must not require ../tools at load time. At activation time the tool
  // surface is fully loaded. The snapshot excludes the module being enabled
  // (it is not in activeModules yet), so a module never conflicts with itself.
  const { getBuiltinRegistry } = require("../tools");
  const descriptors = getBuiltinRegistry().listInDefinitionOrder();
  const toolNames = [];
  const aliases = [];
  for (const descriptor of descriptors) {
    toolNames.push(stripSidekickPrefix(descriptor.name));
    for (const alias of descriptor.aliases || []) aliases.push(stripSidekickPrefix(alias));
  }
  // Generated (dynamic) tools never appear in the builtin registry, but the
  // dispatcher falls back to them by name and the legacy risk lookup consults
  // them in ANY state — a module tool with a colliding name would shadow the
  // generated tool and inherit its stored risk. Fail closed on every
  // generated capability name, retired or not.
  const dbStore = require("../db");
  for (const capability of dbStore.listGeneratedCapabilities()) {
    if (capability?.name) toolNames.push(stripSidekickPrefix(capability.name));
  }
  return { descriptors, toolNames, aliases };
}

/**
 * Per-dispatch gate for module-owned tools: the persisted lifecycle state is
 * authoritative across processes, so a module disabled anywhere stops
 * dispatching everywhere on the next call, not on the next restart. When the
 * persisted state is no longer dispatchable this process self-heals by
 * dropping its stale local registration.
 */
function checkModuleDispatchable(moduleName) {
  const record = repository.getModule(moduleName);
  if (record && (record.state === "enabled" || record.state === "healthy")) {
    return { ok: true, state: record.state };
  }
  activeModules.delete(String(moduleName));
  return { ok: false, state: record ? record.state : "unregistered" };
}

/**
 * Reconcile local registrations with the persisted lifecycle states:
 * deactivate modules another process moved out of enabled/healthy, and
 * re-activate persisted enabled modules whose entry we hold. Cheap enough to
 * run on a timer in every process.
 */
function reconcilePersistedModules(entriesByName = {}) {
  repository.ensureModuleStorage();
  const deactivated = [];
  for (const name of [...activeModules.keys()]) {
    const record = repository.getModule(name);
    if (!record || (record.state !== "enabled" && record.state !== "healthy")) {
      activeModules.delete(name);
      deactivated.push({ name, state: record ? record.state : "unregistered" });
    }
  }
  const restore = restorePersistedModules(entriesByName);
  return { deactivated, activated: restore.restored, failed: restore.failed };
}

/**
 * Fail an activation closed: record the fault on the module (lifecycle state
 * `error`) when the transition table allows it, then throw. Invalid *usage*
 * (unknown module, state that cannot reach `enabled`) throws without touching
 * module state — that is a caller mistake, not a module fault.
 */
function failActivation(record, message) {
  if ((MODULE_TRANSITIONS[record.state] || []).includes("error")) {
    repository.transitionModule(record.name, "error", { error: message });
  }
  throw new Error(message);
}

function buildModuleDescriptors(record, entry) {
  if (!entry || typeof entry.buildDescriptors !== "function") {
    throw new Error(`Module "${record.name}" entry must expose buildDescriptors(services)`);
  }
  const services = createModuleServices(record.name, record.config, {
    permissions: Array.isArray(record.manifest.permissions) ? record.manifest.permissions : [],
  });
  const built = entry.buildDescriptors(services.v1);
  if (!Array.isArray(built)) {
    throw new Error(`Module "${record.name}" buildDescriptors must return an array of descriptors`);
  }
  return built.map(input =>
    normalizeDescriptor({
      ...input,
      // Detach plain-data metadata from the entry's objects so the module
      // cannot mutate what was reviewed at activation (schema and handler are
      // inherently module code and stay by reference).
      args: freezeDeep(structuredClone(input.args || {})),
      aliases: [...(input.aliases || [])],
      source: `module:${record.name}`,
      family: null,
    })
  );
}

function verifyEntryBinding(record, entry) {
  if (!record.entry_point || !record.entry_hash) {
    // Legacy in-memory registrations have no entry point to bind. Any module
    // that declares an entry point must carry the matching hash.
    if (!record.entry_point && !record.entry_hash) return;
    throw new Error(`Module "${record.name}" has no entry-code binding`);
  }
  if (entry.entryPoint !== record.entry_point || entry.entryHash !== record.entry_hash) {
    throw new Error(`Module "${record.name}" entry-code binding does not match the registered entry point`);
  }
  const entryPath = path.resolve(process.cwd(), record.entry_point);
  const root = path.resolve(process.cwd());
  if (path.relative(root, entryPath).startsWith("..")) throw new Error(`Module "${record.name}" entry point escapes the repository root`);
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex");
  if (actualHash !== record.entry_hash) throw new Error(`Module "${record.name}" entry code hash does not match the registered binding`);
}

/**
 * Register an installed/configured (or persisted enabled) module's tools into
 * the live registry path and persist the `enabled` transition when the module
 * is not already enabled. Idempotent for already-active modules.
 */
function enableModule(name, entry) {
  repository.ensureModuleStorage();
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (isModuleActive(record.name)) {
    return { module: record, descriptors: activeModules.get(record.name), alreadyActive: true };
  }

  const alreadyEnabled = record.state === "enabled" || record.state === "healthy";
  if (!alreadyEnabled && !(MODULE_TRANSITIONS[record.state] || []).includes("enabled")) {
    throw new Error(`Module "${name}" cannot be enabled from state ${record.state}`);
  }

  // Config must be valid before enablement even if it was never explicitly set.
  const configResult = validateModuleConfig(record.manifest, record.config);
  if (!configResult.ok) {
    const details = (configResult.errors || []).map(e => `${e.path}: ${e.message}`).join("; ");
    failActivation(record, `Module "${record.name}" config is invalid: ${details}`);
  }

  let descriptors;
  try {
    verifyEntryBinding(record, entry);
    descriptors = buildModuleDescriptors(record, entry);
  } catch (error) {
    failActivation(record, `Module "${record.name}" descriptor construction failed: ${error.message}`);
  }

  const verification = verifyModuleTools(record.manifest, descriptors);
  if (!verification.ok) {
    failActivation(record, `Module "${record.name}" tool verification failed: ${verification.errors.join("; ")}`);
  }

  const live = liveRegistrySnapshot();
  const ownership = checkManifestOwnership(record.manifest, {
    toolNames: live.toolNames,
    aliases: live.aliases,
    installedModules: getActiveModuleNames(),
  });
  if (!ownership.ok) {
    failActivation(record, `Module "${record.name}" ownership check failed: ${ownership.errors.join("; ")}`);
  }

  activeModules.set(record.name, Object.freeze(descriptors));
  try {
    // Prove the combined registry still builds under its own duplicate rules
    // before reporting success — belt and braces over checkManifestOwnership.
    require("../tools").getBuiltinRegistry();
    if (!alreadyEnabled) repository.transitionModule(record.name, "enabled");
  } catch (error) {
    activeModules.delete(record.name);
    failActivation(record, `Module "${record.name}" activation failed: ${error.message}`);
  }

  return { module: repository.getModule(record.name), descriptors: activeModules.get(record.name), alreadyActive: false };
}

/**
 * Remove a module's tools from the live registry path and persist the
 * `disabled` transition (stop_new_work semantics: registrations disappear,
 * data is retained).
 */
function disableModule(name) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  // Persist the transition BEFORE deregistering: if persistence fails, the
  // module stays active and consistent instead of vanishing in-process while
  // the row stays `enabled` (which would resurrect it on the next restore).
  let module = record;
  if (record.state === "enabled" || record.state === "healthy") {
    module = repository.transitionModule(record.name, "disabled");
  }
  activeModules.delete(record.name);
  return { module, deactivated: true };
}

/**
 * Re-activate persisted enabled/healthy modules after a process restart.
 * `entriesByName` maps module name -> entry.
 *
 * A missing entry is a PROCESS-LOCAL condition, not a module fault: it is
 * reported in `failed` (and surfaces as an enabled-but-inactive health issue
 * here) but never persists a global `error` transition — otherwise any one
 * process lacking a module's entry would kill the module for every process
 * that serves it correctly. True activation faults (invalid config, ownership
 * conflicts) are persisted to `error` by enableModule itself.
 */
function restorePersistedModules(entriesByName = {}) {
  repository.ensureModuleStorage();
  const restored = [];
  const failed = [];
  const candidates = repository
    .listModules()
    .filter(m => (m.state === "enabled" || m.state === "healthy") && !isModuleActive(m.name));
  for (const record of candidates) {
    const entry = entriesByName[record.name];
    if (!entry) {
      failed.push({ name: record.name, error: `Module "${record.name}" is enabled but no entry is available in this process` });
      continue;
    }
    try {
      enableModule(record.name, entry);
      restored.push(record.name);
    } catch (error) {
      failed.push({ name: record.name, error: error.message });
    }
  }
  return { restored, failed };
}

module.exports = {
  getActiveDescriptors,
  getActiveModuleNames,
  isModuleActive,
  resolveActiveDescriptor,
  checkModuleDispatchable,
  reconcilePersistedModules,
  enableModule,
  disableModule,
  restorePersistedModules,
};
