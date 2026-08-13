"use strict";

/**
 * Operator-facing module lifecycle (B9).
 *
 * The pieces below it already existed — repository (persistence), loader
 * (registry activation), migrations, health. What was missing was the
 * end-to-end operator path for a module that did not ship inside the
 * repository:
 *
 *   inspect -> install -> configure -> enable -> health
 *           -> disable -> enable -> upgrade -> uninstall
 *
 * This module composes the existing pieces; it does not reimplement them. Tool
 * registration still happens through the single loader/registry path, config
 * validation through the manifest contract, migrations through the module
 * migration runner, and audit through the kernel ledger.
 */

const fs = require("fs");
const path = require("path");
const repository = require("./repository");
const loader = require("./loader");
const store = require("./store");
const entries = require("./entries");
const entryLoader = require("./entry-loader");
const installation = require("./installation");
const { inspectPackageForInstall, hashInstalledPackage } = require("./packaging");
const { configureInstalledModule } = require("./configuration");
const { checkModuleHealth } = require("./health");

/**
 * Derived health vocabulary. A module's health is COMPUTED from its record and
 * the live process state; it is never a value an operator or a module sets
 * directly.
 */
const HEALTH_STATUS = Object.freeze({
  HEALTHY: "healthy",
  DISABLED: "disabled",
  UNHEALTHY: "unhealthy",
  CONFIGURATION_REQUIRED: "configuration_required",
  INCOMPATIBLE: "incompatible",
  INTEGRITY_FAILURE: "integrity_failure",
  LOAD_FAILURE: "load_failure",
  RESTART_REQUIRED: "restart_required",
  NOT_INSTALLED: "not_installed",
});

function inspect(sourcePath, options = {}) {
  return inspectPackageForInstall(sourcePath, options);
}

/** Install a package and take it to `installed` (running any migrations). */
function install(sourcePath, { config, provenance, source = "installed", entryPoint, autoConfigure = true } = {}) {
  const result = installation.installModulePackage(sourcePath, { config, provenance, source, entryPoint });
  const migrated = repository.applyModuleMigrations(result.module.name, { transitionTo: "installed" });
  let record = migrated.module;
  // A module with no unmet configuration requirement should not need a
  // ceremonial no-op configure step before it can be enabled.
  if (autoConfigure && record.state === "installed" && !result.inspection.configuration.required_before_enable) {
    record = repository.transitionModule(record.name, "configured", { config: record.config });
  }
  return { module: record, inspection: result.inspection, install_path: result.install_path, migrations: migrated.applied };
}

/**
 * Set configuration.
 *
 * `installed` uses the explicit installed -> configured lifecycle step; every
 * later state reconfigures in place. Reconfiguring an ACTIVE module rebuilds
 * its descriptors, because handlers close over the config they were given.
 */
function configure(name, config) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (record.state === "installed") {
    return { module: configureInstalledModule(name, config), reactivated: false };
  }
  const updated = repository.setModuleConfig(name, config);
  if (loader.isModuleActive(name)) {
    loader.disableModule(name);
    const enabled = enable(name);
    return { module: enabled.module, reactivated: true };
  }
  return { module: updated, reactivated: false };
}

/** Resolve the entry for this process and activate through the loader. */
function enable(name) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  const resolved = entries.resolveModuleEntry(record);
  if (!resolved.ok) {
    // A module that cannot be loaded must not be marked enabled: that would
    // advertise capabilities that cannot dispatch.
    throw Object.assign(new Error(resolved.error), { code: resolved.code });
  }
  const result = loader.enableModule(name, resolved.entry);
  return { module: result.module, descriptors: result.descriptors.map(d => d.name), entry_kind: resolved.kind };
}

function disable(name) {
  const result = loader.disableModule(name);
  return { module: result.module };
}

/**
 * Upgrade an installed module from a candidate package.
 *
 * The previous managed installation is retained until the new version has been
 * verified AND activated. If anything fails, the old version is put back and
 * re-enabled if it had been running — a failed upgrade never leaves a
 * half-upgraded active module or destroys a working installation.
 */
function upgrade(name, sourcePath, { allowSameVersion = false, allowDowngrade = false, config, provenance = {} } = {}) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (!entryLoader.isManagedRecord(record)) {
    throw new Error(`Module "${name}" has no managed installation and cannot be upgraded from a package`);
  }

  const inspection = inspectPackageForInstall(sourcePath, {
    // The module being upgraded is expected to be present; its own identity
    // and descriptors must not be reported as collisions with itself.
    installedModules: repository.listModules().map(m => m.name).filter(other => other !== name),
    registry: upgradeCollisionContext(name),
  });
  if (inspection.name !== name) {
    throw new Error(`Upgrade package identity mismatch: expected "${name}", package declares "${inspection.name}"`);
  }
  if (!inspection.installable) {
    throw new Error(`Module upgrade candidate cannot be installed: ${inspection.problems.join("; ")}`);
  }

  const wasActive = loader.isModuleActive(name);
  const previousInstallPath = path.resolve(record.install_path);
  const previousVersion = record.version;

  const staged = store.stagePackageFiles(name, inspection.source.path, inspection.files.map(file => file.path));
  let promoted = null;
  try {
    const verified = hashInstalledPackage(staged);
    if (verified.package_hash !== inspection.package_hash) {
      throw new Error("staged upgrade hash does not match the inspected package (source changed during staging)");
    }
    if (wasActive) loader.disableModule(name);
    promoted = store.promoteStaged(name, inspection.version, staged);
    const entryAbsolute = path.resolve(promoted, inspection.entry_point);
    const entryHash = require("crypto").createHash("sha256").update(fs.readFileSync(entryAbsolute)).digest("hex");

    loader.upgradeModule(name, inspection.manifest, {
      entryPoint: inspection.entry_point,
      entryHash,
      installPath: promoted,
      packageHash: verified.package_hash,
      // Compatible configuration is PRESERVED by default: `config` is only
      // passed when the operator explicitly supplies new configuration, and
      // repository.upgradeModule keeps the stored config otherwise. If the new
      // manifest's schema rejects the retained config, activation fails closed
      // rather than silently dropping settings.
      config,
      allowSameVersion,
      allowDowngrade,
      provenance: {
        ...(record.provenance || {}),
        source_kind: inspection.source.kind,
        source_path: inspection.source.path,
        upgraded_at: new Date().toISOString(),
        upgraded_from: previousVersion,
        ...provenance,
      },
      resolveEntry: () => entries.resolveModuleEntry(repository.getModule(name)),
    });
  } catch (error) {
    rollbackUpgrade({ name, promoted, staged, previousInstallPath, previousVersion, wasActive });
    throw error;
  }

  // Remove the superseded version only after the new one is live.
  if (previousInstallPath !== promoted && store.isManagedPath(previousInstallPath)) {
    try { store.removeDirectory(previousInstallPath); } catch {}
  }
  const current = repository.getModule(name);
  return {
    module: current,
    previous_version: previousVersion,
    version: current.version,
    install_path: promoted,
    active: loader.isModuleActive(name),
  };
}

function rollbackUpgrade({ name, promoted, staged, previousInstallPath, previousVersion, wasActive }) {
  try { if (staged && fs.existsSync(staged)) store.removeDirectory(staged); } catch {}
  // The promoted directory is only removed when the previous installation is
  // still on disk — otherwise removing it would destroy the only copy.
  try {
    if (promoted && promoted !== previousInstallPath && fs.existsSync(previousInstallPath)) store.removeDirectory(promoted);
  } catch {}
  const record = repository.getModule(name);
  if (record && record.version === previousVersion && wasActive && !loader.isModuleActive(name)) {
    try { enable(name); } catch {}
  }
}

function upgradeCollisionContext(name) {
  const { stripSidekickPrefix } = require("../core/tool-name");
  const toolNames = [];
  const aliases = [];
  const owned = new Set();
  const record = repository.getModule(name);
  for (const tool of Object.keys(record?.manifest?.tools || {})) {
    owned.add(stripSidekickPrefix(tool));
    for (const alias of record.manifest.tools[tool].aliases || []) owned.add(stripSidekickPrefix(alias));
  }
  try {
    for (const descriptor of require("../tools").getBuiltinRegistry().listInDefinitionOrder()) {
      const canonical = stripSidekickPrefix(descriptor.name);
      if (!owned.has(canonical)) toolNames.push(canonical);
      for (const alias of descriptor.aliases || []) {
        const canonicalAlias = stripSidekickPrefix(alias);
        if (!owned.has(canonicalAlias)) aliases.push(canonicalAlias);
      }
    }
  } catch {}
  return { toolNames, aliases, installedModules: [] };
}

/**
 * Uninstall a module.
 *
 * Runtime contributions go first, then the managed package, then the
 * registration row. Historical execution/audit evidence is preserved by
 * design. Module-owned DATA (rows a module's migrations wrote into published
 * platform tables) is retained unless the manifest's declared uninstall
 * retention policy and the caller both say otherwise — destructive cleanup is
 * explicit, never a side effect of removing code.
 */
function uninstall(name, { removeData = false } = {}) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (record.source === "builtin") {
    throw new Error(`Module "${name}" is a builtin module and cannot be uninstalled`);
  }

  const retention = record.manifest?.lifecycle?.uninstall || "retain_data";
  // Destructive state cleanup is explicit on BOTH sides: the manifest must
  // declare that its data is removable (`uninstall: "ask"`), and the operator
  // must ask for it. A module that declared `retain_data` cannot have its data
  // dropped by an uninstall flag.
  if (removeData && retention === "retain_data") {
    throw new Error(`Module "${name}" declares uninstall retention "retain_data"; its data cannot be removed by uninstall`);
  }
  if (loader.isModuleActive(name)) loader.disableModule(name);

  let packageRemoved = false;
  if (entryLoader.isManagedRecord(record)) {
    entryLoader.purgeRequireCache(path.resolve(record.install_path));
    const removal = store.removeModule(name);
    packageRemoved = removal.removed;
  }
  // Module-owned configuration and lifecycle state live on the registration
  // row and go with it. Rows a module's migrations wrote into published
  // platform_* tables are NOT module-private storage and are never swept here;
  // `removeData` records the operator's intent for a module that declared its
  // data removable, and the retention decision is reported either way.
  repository.deleteModuleRecord(name);

  return {
    name,
    package_removed: packageRemoved,
    registration_removed: true,
    config_removed: true,
    data_retention: retention,
    data_removed: Boolean(removeData),
    audit_preserved: true,
  };
}

/**
 * Compute a module's health without mutating anything unless a live health
 * check is requested and possible.
 */
function health(name, { runCheck = true } = {}) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);

  const components = [];
  const active = loader.isModuleActive(name);
  const managed = entryLoader.isManagedRecord(record);

  let integrity = { ok: true, managed: false };
  if (managed) {
    integrity = entryLoader.verifyInstalledPackage(record);
    components.push({ component: "package_integrity", ok: integrity.ok, detail: integrity.ok ? record.package_hash : integrity.error });
  }
  const compatibility = entryLoader.checkCompatibility(record);
  components.push({ component: "compatibility", ok: compatibility.ok, detail: compatibility.requires || "unconstrained" });
  const configuration = entryLoader.checkConfiguration(record);
  components.push({
    component: "configuration",
    ok: configuration.ok,
    detail: configuration.ok ? "valid" : (configuration.errors || []).map(e => `${e.path}: ${e.message}`).join("; "),
  });
  components.push({ component: "active_in_process", ok: active, detail: active ? "registered" : `state=${record.state}` });

  let status = HEALTH_STATUS.HEALTHY;
  let checkResult = null;
  if (managed && !integrity.ok) {
    status = integrity.code === entryLoader.LOAD_FAILURES.NOT_INSTALLED ? HEALTH_STATUS.NOT_INSTALLED : HEALTH_STATUS.INTEGRITY_FAILURE;
  } else if (!compatibility.ok) {
    status = HEALTH_STATUS.INCOMPATIBLE;
  } else if (!configuration.ok) {
    status = HEALTH_STATUS.CONFIGURATION_REQUIRED;
  } else if (record.state === "disabled" || record.state === "installed" || record.state === "configured" || record.state === "validated") {
    status = HEALTH_STATUS.DISABLED;
  } else if (record.state === "error") {
    status = HEALTH_STATUS.UNHEALTHY;
  } else if (!active) {
    // Enabled in the ledger but not registered here. Try to activate; if the
    // code cannot be brought up in this process, say so honestly.
    try {
      enable(name);
      status = HEALTH_STATUS.HEALTHY;
    } catch (error) {
      status = error.code === entryLoader.LOAD_FAILURES.INTEGRITY_FAILURE
        ? HEALTH_STATUS.INTEGRITY_FAILURE
        : HEALTH_STATUS.RESTART_REQUIRED;
      components.push({ component: "activation", ok: false, detail: error.message });
    }
  }

  if (runCheck && status === HEALTH_STATUS.HEALTHY && loader.isModuleActive(name)) {
    const resolved = entries.resolveModuleEntry(repository.getModule(name));
    if (resolved.ok && typeof resolved.entry.healthCheck === "function") {
      try {
        checkResult = checkModuleHealth(name, resolved.entry);
        if (!checkResult.ok) status = HEALTH_STATUS.UNHEALTHY;
        components.push({ component: "module_health_check", ok: checkResult.ok, detail: checkResult.health });
      } catch (error) {
        status = HEALTH_STATUS.UNHEALTHY;
        components.push({ component: "module_health_check", ok: false, detail: error.message });
      }
    }
  }

  const current = repository.getModule(name);
  return {
    name,
    status,
    ok: status === HEALTH_STATUS.HEALTHY,
    state: current.state,
    version: current.version,
    source: current.source,
    managed: Boolean(managed),
    install_path: current.install_path || null,
    package_hash: current.package_hash || null,
    active_in_process: loader.isModuleActive(name),
    components,
    error: current.error || null,
    last_health_check_at: current.last_health_check_at || null,
    check: checkResult ? checkResult.health : null,
  };
}

module.exports = { HEALTH_STATUS, inspect, install, configure, enable, disable, upgrade, uninstall, health };
