"use strict";

/**
 * Capability-pack lifecycle.
 *
 * A pack install is an ORCHESTRATION of existing subsystems, never a
 * reimplementation of them:
 *
 *   owned modules   -> src/modules/lifecycle.js (the B9 module lifecycle)
 *   owned workflows -> src/workflows/repository.js (definition registry)
 *   owned knowledge -> the knowledge store
 *   configuration   -> validated here, handed to modules that opted in
 *   health          -> DERIVED from the components above, never set by hand
 *
 * Ownership is recorded in platform_capability_pack_components so that
 * disable, upgrade and uninstall can act on exactly what the pack contributed
 * and nothing else. Duplicate ownership is refused: two packs may not claim the
 * same module, workflow or knowledge asset.
 */

const fs = require("fs");
const path = require("path");
const repository = require("./repository");
const store = require("./store");
const packKnowledge = require("./knowledge");
const { inspectPackPackage, hashInstalledPack } = require("./packaging");
const {
  validatePackConfig,
  checkPackCompatibility,
  checkPackApi,
  comparePackPermissions,
  packManifestSchema,
  readPackManifestFile,
  PACK_MANIFEST_FILENAME,
} = require("./manifest");
const packDependencies = require("./dependencies");
const moduleLifecycle = require("../modules/lifecycle");
const moduleRepository = require("../modules/repository");
const moduleLoader = require("../modules/loader");
const workflowRepository = require("../workflows/repository");
const { sidekickVersion } = require("../modules/packaging");

const HEALTH_STATUS = Object.freeze({
  HEALTHY: "healthy",
  DISABLED: "disabled",
  DEGRADED: "degraded",
  CONFIGURATION_REQUIRED: "configuration_required",
  INCOMPATIBLE: "incompatible",
  INTEGRITY_FAILURE: "integrity_failure",
  COMPONENT_FAILURE: "component_failure",
  RESTART_REQUIRED: "restart_required",
});

function inspect(sourcePath, options = {}) {
  const inspection = inspectPackPackage(sourcePath, options);
  const { _components, ...operatorFacing } = inspection;
  return operatorFacing;
}

/**
 * Install a capability pack.
 *
 * Ordering is deliberate: everything is validated before anything is written,
 * the package is copied and re-hashed before any component is installed, and
 * component installation is rolled back on failure so a half-installed pack is
 * not left behind.
 *
 * A newly installed pack is left DISABLED (state `installed`). Installing code
 * and activating code are separate operator decisions.
 */
function install(sourcePath, { config, provenance = "third_party", source = {}, enable: enableAfterInstall = false } = {}) {
  const inspection = inspectPackPackage(sourcePath, { sourceKind: source.kind });
  if (!inspection.installable) {
    throw new Error(`Capability pack cannot be installed: ${inspection.problems.join("; ")}`);
  }
  if (repository.getPack(inspection.name)) {
    throw new Error(`Capability pack "${inspection.name}" is already installed`);
  }
  assertNoForeignOwnership(inspection);
  store.recoverStaging(inspection.name);

  const configResult = validatePackConfig(inspection.manifest, config);
  if (!configResult.ok) {
    throw new Error(`Capability pack configuration is invalid: ${configResult.errors.map(e => `${e.path}: ${e.message}`).join("; ")}`);
  }

  const installPath = store.installPackFiles(
    inspection.name,
    inspection.version,
    inspection._components.root,
    inspection.files.map(file => file.path)
  );

  const installed = { modules: [], workflows: [], knowledge: [] };
  let record;
  try {
    const verified = hashInstalledPack(installPath);
    if (verified.package_hash !== inspection.package_hash) {
      throw new Error("managed pack installation hash does not match the inspected package (source changed during install)");
    }
    record = repository.registerPack(inspection.manifest, {
      provenance,
      packageHash: verified.package_hash,
      installPath,
      source: { kind: source.kind || "local_path", path: inspection.source.path, installed_at: new Date().toISOString(), ...source },
      config: configResult.config,
    });
    installComponents(record, inspection, installPath, installed);
  } catch (error) {
    rollbackInstall(inspection.name, installed, installPath, Boolean(record));
    throw error;
  }

  let current = repository.getPack(inspection.name);
  if (enableAfterInstall) current = enable(inspection.name).pack;
  // Reuse the inspection already computed above rather than re-walking and
  // re-hashing the package; only the internal component handles are stripped.
  const { _components, ...operatorFacingInspection } = inspection;
  return { pack: current, inspection: operatorFacingInspection, install_path: installPath, components: installed };
}

/**
 * Install the pack's components through their owning subsystems, recording
 * ownership as each one lands.
 */
function installComponents(record, inspection, installPath, installed) {
  const packConfig = record.config || {};

  for (const reference of inspection.manifest.modules) {
    const moduleRoot = path.resolve(installPath, reference.path);
    const moduleConfig = reference.config_from_pack ? packConfig : undefined;
    const result = moduleLifecycle.install(moduleRoot, {
      config: moduleConfig,
      source: "pack",
      entryPoint: reference.entry_point,
      provenance: { pack: record.name, pack_version: record.version, source_kind: "capability_pack" },
    });
    installed.modules.push(reference.name);
    repository.recordComponent(record.name, record.version, "module", reference.name, {
      version: result.module.version,
      state: "installed",
      detail: { install_path: result.install_path, tools: Object.keys(result.module.manifest.tools || {}), config_from_pack: reference.config_from_pack },
    });
  }

  for (const entry of inspection._components.workflows) {
    const definition = entry.definition;
    workflowRepository.registerWorkflowDefinition(definition, {
      ownerKind: "pack",
      ownerName: record.name,
      metadata: { pack_version: record.version, path: entry.reference.path },
    });
    // Registered but not runnable until the pack is enabled.
    workflowRepository.setWorkflowDefinitionState(definition.name, "disabled");
    installed.workflows.push(definition.name);
    repository.recordComponent(record.name, record.version, "workflow", definition.name, {
      version: definition.version,
      state: "installed",
      detail: { title: definition.title, mode: definition.mode, steps: definition.steps.length, path: entry.reference.path },
    });
  }

  for (const reference of inspection.manifest.knowledge) {
    const assetPath = path.resolve(installPath, reference.path);
    const asset = packKnowledge.installAsset(record.name, record.version, reference, assetPath);
    packKnowledge.setAssetEnabled(asset.id, false);
    installed.knowledge.push(reference.title);
    repository.recordComponent(record.name, record.version, "knowledge", reference.title, {
      version: record.version,
      state: "installed",
      detail: { knowledge_id: asset.id, category: reference.category, path: reference.path, bytes: asset.bytes },
    });
  }
}

function rollbackInstall(packName, installed, installPath, packRegistered) {
  for (const title of installed.knowledge) {
    const component = repository.getComponent(packName, "knowledge", title);
    if (component?.detail?.knowledge_id) {
      try { packKnowledge.removeAsset(component.detail.knowledge_id); } catch {}
    }
  }
  for (const name of installed.workflows) {
    try { workflowRepository.removeWorkflowDefinition(name); } catch {}
  }
  for (const name of installed.modules) {
    try { moduleLifecycle.uninstall(name); } catch {}
  }
  if (packRegistered) {
    try { repository.deletePack(packName); } catch {}
  }
  try { store.removeDirectory(installPath); } catch {}
}

/**
 * Refuse to install a pack whose components are already owned by a different
 * pack (or, for modules, already registered independently). Duplicate
 * ownership is the failure mode that makes upgrade and uninstall incoherent.
 */
function assertNoForeignOwnership(inspection, { allowPack = null } = {}) {
  const conflicts = [];
  for (const reference of inspection.manifest.modules) {
    const owner = repository.findComponentOwner("module", reference.name);
    if (owner && owner.pack_name !== allowPack) conflicts.push(`module "${reference.name}" is owned by pack "${owner.pack_name}"`);
    const existing = moduleRepository.getModule(reference.name);
    if (existing && (!owner || owner.pack_name !== allowPack)) conflicts.push(`module "${reference.name}" is already registered`);
  }
  for (const workflow of inspection.workflows) {
    const owner = repository.findComponentOwner("workflow", workflow.name);
    if (owner && owner.pack_name !== allowPack) conflicts.push(`workflow "${workflow.name}" is owned by pack "${owner.pack_name}"`);
    const existing = workflowRepository.getWorkflowDefinition(workflow.name);
    if (existing && (existing.owner_kind !== "pack" || existing.owner_name !== allowPack)) {
      conflicts.push(`workflow "${workflow.name}" is already registered by ${existing.owner_kind}${existing.owner_name ? `:${existing.owner_name}` : ""}`);
    }
  }
  for (const asset of inspection.knowledge) {
    const owner = repository.findComponentOwner("knowledge", asset.title);
    if (owner && owner.pack_name !== allowPack) conflicts.push(`knowledge "${asset.title}" is owned by pack "${owner.pack_name}"`);
  }
  if (conflicts.length) throw new Error(`Capability pack component ownership conflict: ${conflicts.join("; ")}`);
}

/** Validate and persist pack configuration, propagating it to opted-in modules. */
function configure(name, config) {
  const record = repository.getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);
  const updated = repository.setPackConfig(name, config);
  const propagated = [];
  for (const reference of updated.manifest.modules || []) {
    if (!reference.config_from_pack) continue;
    if (!moduleRepository.getModule(reference.name)) continue;
    moduleLifecycle.configure(reference.name, updated.config);
    propagated.push(reference.name);
  }
  if (updated.state === "installed") repository.setPackState(name, "configured");
  return { pack: repository.getPack(name), propagated_to_modules: propagated };
}

/**
 * Enable a pack: make its capabilities actually available.
 *
 * Modules are enabled through the module lifecycle (so integrity, compatibility
 * and configuration checks all run), workflow definitions are moved to
 * `registered`, and knowledge rows are re-enabled. If any module fails to
 * enable, the pack does not report enabled — it reports the component failure.
 */
function enable(name) {
  const record = repository.getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);

  const compatibility = checkPackCompatibility(record.manifest, sidekickVersion());
  if (!compatibility.ok) {
    repository.setPackState(name, "error", { error: `incompatible: requires Sidekick ${compatibility.requires}` });
    throw new Error(`Capability pack "${name}" requires Sidekick ${compatibility.requires} but this Sidekick is ${compatibility.sidekick_version}`);
  }
  const packApi = checkPackApi(record.manifest);
  if (!packApi.ok) {
    repository.setPackState(name, "error", { error: `unsupported pack_api ${packApi.pack_api}` });
    throw new Error(`Capability pack "${name}" declares pack_api ${packApi.pack_api} but this Sidekick supports pack_api ${packApi.supported.join(", ")}`);
  }
  const configResult = validatePackConfig(record.manifest, record.config);
  if (!configResult.ok) {
    throw new Error(`Capability pack "${name}" configuration is invalid: ${configResult.errors.map(e => `${e.path}: ${e.message}`).join("; ")}`);
  }

  // Required dependencies must be live before this pack's capabilities are:
  // a dependent that enabled ahead of its provider would advertise tools and
  // workflows whose collaborators are absent.
  const dependencyBlockers = packDependencies.requiredReadinessProblems(record.manifest, { requireEnabled: true });
  if (dependencyBlockers.length) {
    throw new Error(`Capability pack "${name}" cannot be enabled: required dependency not ready: ${dependencyBlockers.join("; ")}`);
  }

  const activated = { modules: [], workflows: [], knowledge: [] };
  const failures = [];

  for (const component of repository.listComponents(name, { kind: "module" })) {
    try {
      const result = moduleLifecycle.enable(component.ref);
      repository.setComponentState(name, "module", component.ref, "enabled");
      activated.modules.push({ name: component.ref, tools: result.descriptors });
    } catch (error) {
      failures.push({ kind: "module", ref: component.ref, error: error.message, code: error.code || null });
      repository.setComponentState(name, "module", component.ref, "error");
    }
  }

  if (failures.length) {
    // Do not advertise a partially-live pack. Roll the activated components
    // back so the pack's capabilities are all-or-nothing.
    for (const module of activated.modules) {
      try { moduleLifecycle.disable(module.name); } catch {}
      repository.setComponentState(name, "module", module.name, "installed");
    }
    repository.setPackState(name, "error", { error: failures.map(f => `${f.kind} ${f.ref}: ${f.error}`).join("; ") });
    const error = new Error(`Capability pack "${name}" could not be enabled: ${failures.map(f => `${f.kind} ${f.ref}: ${f.error}`).join("; ")}`);
    error.failures = failures;
    throw error;
  }

  // A provider can change in another process while module activation is in
  // progress. Re-read the dependency set before making workflows, knowledge,
  // and the pack itself live; otherwise a dependent could become visible
  // after its authority was withdrawn. Roll back activated modules and fail
  // closed if the second check disagrees with the first.
  const lateDependencyBlockers = packDependencies.requiredReadinessProblems(record.manifest, { requireEnabled: true });
  if (lateDependencyBlockers.length) {
    for (const module of activated.modules) {
      try { moduleLifecycle.disable(module.name); } catch {}
      repository.setComponentState(name, "module", module.name, "installed");
    }
    repository.setPackState(name, "error", {
      error: `required dependency changed during enable: ${lateDependencyBlockers.join("; ")}`,
    });
    throw new Error(`Capability pack "${name}" cannot be enabled: required dependency changed during enable: ${lateDependencyBlockers.join("; ")}`);
  }

  for (const component of repository.listComponents(name, { kind: "workflow" })) {
    workflowRepository.setWorkflowDefinitionState(component.ref, "registered");
    repository.setComponentState(name, "workflow", component.ref, "enabled");
    activated.workflows.push(component.ref);
  }
  for (const component of repository.listComponents(name, { kind: "knowledge" })) {
    if (component.detail?.knowledge_id) packKnowledge.setAssetEnabled(component.detail.knowledge_id, true);
    repository.setComponentState(name, "knowledge", component.ref, "enabled");
    activated.knowledge.push(component.ref);
  }

  repository.setPackState(name, "enabled");
  const report = health(name);
  repository.recordPackHealth(name, report);
  return { pack: repository.getPack(name), activated, health: report };
}

/**
 * Disable a pack: remove its ACTIVE capabilities coherently.
 *
 * Nothing historical is destroyed — module registrations, workflow definitions
 * and knowledge content all remain; they simply stop being available.
 */
function disable(name) {
  const record = repository.getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);

  // Refuse to pull a provider out from under live dependents. The dependents
  // are named so the remedy is obvious; disabling them first is the path.
  const enabledDependents = packDependencies.listRequiredDependents(name, { enabledOnly: true });
  if (enabledDependents.length) {
    throw new Error(
      `Capability pack "${name}" cannot be disabled: enabled pack(s) require it: ${enabledDependents.map(p => p.name).join(", ")}. Disable those packs first.`
    );
  }

  const deactivated = { modules: [], workflows: [], knowledge: [] };
  const disabledModules = [];
  const disableFailures = [];

  // Teardown is part of the security boundary: never mark a component (or
  // the pack) disabled if its live module could not actually be stopped.
  // Restore modules already stopped when a later module fails, preserving the
  // all-or-nothing contract as far as the in-process loader permits.
  for (const component of repository.listComponents(name, { kind: "module" })) {
    if (!moduleRepository.getModule(component.ref) || !moduleLoader.isModuleActive(component.ref)) continue;
    try {
      moduleLifecycle.disable(component.ref);
      disabledModules.push(component.ref);
    } catch (error) {
      disableFailures.push({ ref: component.ref, error: error.message });
    }
  }
  if (disableFailures.length) {
    for (const ref of disabledModules) {
      try { moduleLifecycle.enable(ref); } catch {}
    }
    throw new Error(`Capability pack "${name}" could not be disabled: ${disableFailures.map(f => `${f.ref}: ${f.error}`).join("; ")}`);
  }
  for (const component of repository.listComponents(name, { kind: "module" })) {
    repository.setComponentState(name, "module", component.ref, "disabled");
    deactivated.modules.push(component.ref);
  }
  for (const component of repository.listComponents(name, { kind: "workflow" })) {
    if (workflowRepository.getWorkflowDefinition(component.ref)) {
      workflowRepository.setWorkflowDefinitionState(component.ref, "disabled");
    }
    repository.setComponentState(name, "workflow", component.ref, "disabled");
    deactivated.workflows.push(component.ref);
  }
  for (const component of repository.listComponents(name, { kind: "knowledge" })) {
    if (component.detail?.knowledge_id) packKnowledge.setAssetEnabled(component.detail.knowledge_id, false);
    repository.setComponentState(name, "knowledge", component.ref, "disabled");
    deactivated.knowledge.push(component.ref);
  }

  repository.setPackState(name, "disabled");
  return { pack: repository.getPack(name), deactivated };
}

/**
 * Upgrade a pack from a candidate package.
 *
 * Components present in the new version are upgraded in place; components the
 * new version no longer contains are removed. Ownership rows are rewritten, so
 * an upgrade never leaves two owners for one component or an orphan claiming
 * to belong to a version that no longer ships it.
 */
function upgrade(name, sourcePath, { allowSameVersion = false, allowDowngrade = false, config } = {}) {
  const record = repository.getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);
  const wasEnabled = record.state === "enabled";

  const inspection = inspectPackPackage(sourcePath, { replacingPack: name, installedModules: [] });
  if (inspection.name !== name) {
    throw new Error(`Pack upgrade identity mismatch: expected "${name}", package declares "${inspection.name}"`);
  }
  if (!inspection.installable) {
    throw new Error(`Capability pack upgrade candidate cannot be installed: ${inspection.problems.join("; ")}`);
  }
  assertNoForeignOwnership(inspection, { allowPack: name });

  // Upgrade compatibility: every installed dependent's declared range must
  // still accept the candidate version. Optional dependents warn; required
  // dependents refuse.
  const dependentCheck = packDependencies.checkDependentConstraints(name, inspection.version);
  if (!dependentCheck.ok) {
    throw new Error(`Capability pack "${name}" cannot be upgraded to ${inspection.version}: ${dependentCheck.broken.join("; ")}`);
  }

  const previousInstallPath = record.install_path;
  const previousVersion = record.version;
  store.recoverStaging(name);
  const staged = store.stagePackFiles(name, inspection._components.root, inspection.files.map(file => file.path));
  let promoted = null;
  try {
    const verified = hashInstalledPack(staged);
    if (verified.package_hash !== inspection.package_hash) {
      throw new Error("staged pack upgrade hash does not match the inspected package");
    }
    promoted = store.promoteStaged(name, inspection.version, staged);

    const updated = repository.updatePackPackage(name, inspection.manifest, {
      packageHash: verified.package_hash,
      installPath: promoted,
      source: { ...record.source, upgraded_at: new Date().toISOString(), upgraded_from: previousVersion, path: inspection.source.path },
      config,
      allowSameVersion,
      allowDowngrade,
    });

    upgradeComponents(updated, inspection, promoted, previousVersion);
  } catch (error) {
    // updatePackPackage runs before component reconciliation. If a dropped
    // component cannot be removed, restore the prior package record before
    // removing the promoted files; otherwise the registry would point at a
    // deleted package and the old ownership graph would be misreported.
    try {
      const current = repository.getPack(name);
      if (current && (current.version !== previousVersion || current.install_path === promoted)) {
        repository.restorePackPackage(name, record);
      }
    } catch (restoreError) {
      error.message = `${error.message}; pack metadata rollback failed: ${restoreError.message}`;
      error.code = "pack_upgrade_rollback_failed";
    }
    try { if (staged && fs.existsSync(staged)) store.removeDirectory(staged); } catch {}
    try {
      if (promoted && promoted !== previousInstallPath && previousInstallPath && fs.existsSync(previousInstallPath)) store.removeDirectory(promoted);
    } catch {}
    throw error;
  }

  if (previousInstallPath && previousInstallPath !== promoted && store.isManagedPath(previousInstallPath)) {
    try { store.removeDirectory(previousInstallPath); } catch {}
  }

  let current = repository.getPack(name);
  let report = health(name);
  if (wasEnabled) {
    current = enable(name).pack;
    report = health(name);
  }
  return { pack: current, previous_version: previousVersion, version: current.version, health: report, install_path: promoted };
}

function upgradeComponents(record, inspection, installPath, previousVersion) {
  const nextModules = new Set(inspection.manifest.modules.map(reference => reference.name));
  const nextWorkflows = new Set(inspection.workflows.map(workflow => workflow.name));
  const nextKnowledge = new Set(inspection.manifest.knowledge.map(asset => asset.title));

  // Components dropped by the new version are removed entirely.
  for (const component of repository.listComponents(record.name, { kind: "module" })) {
    if (nextModules.has(component.ref)) continue;
    moduleLifecycle.uninstall(component.ref);
    repository.removeComponent(record.name, "module", component.ref);
  }
  for (const component of repository.listComponents(record.name, { kind: "workflow" })) {
    if (nextWorkflows.has(component.ref)) continue;
    workflowRepository.removeWorkflowDefinition(component.ref);
    repository.removeComponent(record.name, "workflow", component.ref);
  }
  for (const component of repository.listComponents(record.name, { kind: "knowledge" })) {
    if (nextKnowledge.has(component.ref)) continue;
    if (component.detail?.knowledge_id) {
      packKnowledge.removeAsset(component.detail.knowledge_id);
    }
    repository.removeComponent(record.name, "knowledge", component.ref);
  }

  for (const reference of inspection.manifest.modules) {
    const moduleRoot = path.resolve(installPath, reference.path);
    const existing = moduleRepository.getModule(reference.name);
    const moduleConfig = reference.config_from_pack ? record.config : undefined;
    if (existing) {
      const candidateVersion = inspection.modules.find(m => m.name === reference.name)?.version;
      const same = candidateVersion === existing.version;
      moduleLifecycle.upgrade(reference.name, moduleRoot, {
        allowSameVersion: same,
        allowDowngrade: true,
        config: moduleConfig,
        provenance: { pack: record.name, pack_version: record.version },
      });
    } else {
      moduleLifecycle.install(moduleRoot, {
        config: moduleConfig,
        source: "pack",
        entryPoint: reference.entry_point,
        provenance: { pack: record.name, pack_version: record.version, source_kind: "capability_pack" },
      });
    }
    const current = moduleRepository.getModule(reference.name);
    repository.recordComponent(record.name, record.version, "module", reference.name, {
      version: current.version,
      state: current.state === "enabled" || current.state === "healthy" ? "enabled" : "installed",
      detail: { install_path: current.install_path, tools: Object.keys(current.manifest.tools || {}), config_from_pack: reference.config_from_pack },
    });
  }

  for (const entry of inspection._components.workflows) {
    const definition = entry.definition;
    workflowRepository.registerWorkflowDefinition(definition, {
      ownerKind: "pack",
      ownerName: record.name,
      metadata: { pack_version: record.version, path: entry.reference.path },
    });
    workflowRepository.setWorkflowDefinitionState(definition.name, record.state === "enabled" ? "registered" : "disabled");
    repository.recordComponent(record.name, record.version, "workflow", definition.name, {
      version: definition.version,
      state: record.state === "enabled" ? "enabled" : "installed",
      detail: { title: definition.title, mode: definition.mode, steps: definition.steps.length, path: entry.reference.path },
    });
  }

  for (const reference of inspection.manifest.knowledge) {
    const assetPath = path.resolve(installPath, reference.path);
    const asset = packKnowledge.installAsset(record.name, record.version, reference, assetPath);
    packKnowledge.setAssetEnabled(asset.id, record.state === "enabled");
    repository.recordComponent(record.name, record.version, "knowledge", reference.title, {
      version: record.version,
      state: record.state === "enabled" ? "enabled" : "installed",
      detail: { knowledge_id: asset.id, category: reference.category, path: reference.path, bytes: asset.bytes },
    });
  }
}

/**
 * Uninstall a pack.
 *
 * Active capabilities go first, then owned components, then the managed
 * package and the pack record. Kernel ledger events and tool logs are retained
 * — history about what the system did must survive the removal of the thing
 * that did it.
 */
function uninstall(name, { removeKnowledge = true, removeModuleData = false } = {}) {
  const record = repository.getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);

  // A pack with installed required dependents cannot be removed — even
  // disabled dependents would be left permanently unable to enable.
  const dependents = packDependencies.listRequiredDependents(name);
  if (dependents.length) {
    throw new Error(
      `Capability pack "${name}" cannot be uninstalled: installed pack(s) require it: ${dependents.map(p => p.name).join(", ")}. Uninstall those packs first.`
    );
  }

  if (record.state === "enabled") disable(name);

  const removed = { modules: [], workflows: [], knowledge: [] };
  for (const component of repository.listComponents(name, { kind: "module" })) {
    if (moduleRepository.getModule(component.ref)) {
      moduleLifecycle.uninstall(component.ref, { removeData: removeModuleData });
    }
    repository.removeComponent(name, "module", component.ref);
    removed.modules.push(component.ref);
  }
  for (const component of repository.listComponents(name, { kind: "workflow" })) {
    workflowRepository.removeWorkflowDefinition(component.ref);
    repository.removeComponent(name, "workflow", component.ref);
    removed.workflows.push(component.ref);
  }
  for (const component of repository.listComponents(name, { kind: "knowledge" })) {
    if (removeKnowledge && component.detail?.knowledge_id) packKnowledge.removeAsset(component.detail.knowledge_id);
    else if (component.detail?.knowledge_id) packKnowledge.setAssetEnabled(component.detail.knowledge_id, false);
    repository.removeComponent(name, "knowledge", component.ref);
    removed.knowledge.push(component.ref);
  }

  let packageRemoved = false;
  if (record.install_path && store.isManagedPath(record.install_path)) {
    packageRemoved = store.removePack(name).removed;
  }
  repository.deletePack(name);

  return {
    name,
    removed,
    package_removed: packageRemoved,
    knowledge_retention: removeKnowledge ? "removed" : "retained_disabled",
    audit_preserved: true,
  };
}

/**
 * Derive pack health from its components.
 *
 * A pack is never healthier than the components it owns: if a required module
 * fails integrity verification, the pack reports integrity_failure regardless
 * of what its own row says.
 */
function health(name) {
  const record = repository.getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);

  const components = [];
  let worst = null;
  const escalate = status => {
    const severity = {
      [HEALTH_STATUS.HEALTHY]: 0,
      [HEALTH_STATUS.DISABLED]: 1,
      [HEALTH_STATUS.RESTART_REQUIRED]: 2,
      [HEALTH_STATUS.DEGRADED]: 3,
      [HEALTH_STATUS.CONFIGURATION_REQUIRED]: 4,
      [HEALTH_STATUS.COMPONENT_FAILURE]: 5,
      [HEALTH_STATUS.INCOMPATIBLE]: 6,
      [HEALTH_STATUS.INTEGRITY_FAILURE]: 7,
    };
    if (worst === null || severity[status] > severity[worst]) worst = status;
  };

  const compatibility = checkPackCompatibility(record.manifest, sidekickVersion());
  components.push({ component: "compatibility", kind: "pack", ok: compatibility.ok, detail: compatibility.requires || "unconstrained" });
  if (!compatibility.ok) escalate(HEALTH_STATUS.INCOMPATIBLE);

  const packApi = checkPackApi(record.manifest);
  components.push({
    component: "pack_api",
    kind: "pack",
    ok: packApi.ok,
    detail: packApi.ok ? `v${packApi.pack_api}` : `declares v${packApi.pack_api}; supported: ${packApi.supported.join(", ")}`,
  });
  if (!packApi.ok) escalate(HEALTH_STATUS.INCOMPATIBLE);

  const configResult = validatePackConfig(record.manifest, record.config);
  components.push({
    component: "configuration",
    kind: "pack",
    ok: configResult.ok,
    detail: configResult.ok ? "valid" : configResult.errors.map(e => `${e.path}: ${e.message}`).join("; "),
  });
  if (!configResult.ok) escalate(HEALTH_STATUS.CONFIGURATION_REQUIRED);

  const enabled = record.state === "enabled";

  for (const component of repository.listComponents(record.name, { kind: "module" })) {
    let moduleHealth;
    try {
      moduleHealth = moduleLifecycle.health(component.ref, { runCheck: enabled });
    } catch (error) {
      components.push({ component: component.ref, kind: "module", ok: false, status: "missing", detail: error.message });
      escalate(HEALTH_STATUS.COMPONENT_FAILURE);
      continue;
    }
    // When the derived status is not healthy, report the FAILING component's
    // own evidence. Falling back to the persisted lifecycle state produced
    // detail like "healthy (active)" next to status "integrity_failure",
    // which reads as a contradiction rather than a diagnosis.
    const failing = moduleHealth.components.find(entry => entry.ok === false);
    components.push({
      component: component.ref,
      kind: "module",
      ok: enabled ? moduleHealth.ok : true,
      status: moduleHealth.status,
      detail: moduleHealth.status === "healthy"
        ? `${moduleHealth.state} (${moduleHealth.active_in_process ? "active" : "inactive"})`
        : (failing ? `${failing.component}: ${failing.detail}` : moduleHealth.error || moduleHealth.status),
    });
    if (moduleHealth.status === "integrity_failure" || moduleHealth.status === "not_installed") escalate(HEALTH_STATUS.INTEGRITY_FAILURE);
    else if (moduleHealth.status === "incompatible") escalate(HEALTH_STATUS.INCOMPATIBLE);
    else if (moduleHealth.status === "configuration_required") escalate(HEALTH_STATUS.CONFIGURATION_REQUIRED);
    else if (moduleHealth.status === "restart_required") escalate(HEALTH_STATUS.RESTART_REQUIRED);
    else if (enabled && !moduleHealth.ok) escalate(HEALTH_STATUS.COMPONENT_FAILURE);
  }

  // Permissions: the stored pack declaration must still agree with what the
  // INSTALLED module manifests hold — a module upgraded out from under the
  // pack would silently change the pack's real grant surface otherwise.
  const installedModuleManifests = repository
    .listComponents(record.name, { kind: "module" })
    .map(component => moduleRepository.getModule(component.ref)?.manifest)
    .filter(Boolean);
  if (record.manifest.permissions) {
    const permissionComparison = comparePackPermissions(record.manifest.permissions, installedModuleManifests);
    components.push({
      component: "permissions",
      kind: "pack",
      ok: permissionComparison.ok,
      status: permissionComparison.ok ? "consistent" : "mismatch",
      detail: permissionComparison.ok
        ? `${record.manifest.permissions.length} declared`
        : [
            permissionComparison.missing.length ? `undeclared module grants: ${permissionComparison.missing.join(", ")}` : null,
            permissionComparison.extra.length ? `declared but unheld: ${permissionComparison.extra.join(", ")}` : null,
          ].filter(Boolean).join("; "),
    });
    if (!permissionComparison.ok) escalate(HEALTH_STATUS.DEGRADED);
  } else {
    const derived = comparePackPermissions(undefined, installedModuleManifests).aggregate;
    components.push({
      component: "permissions",
      kind: "pack",
      ok: true,
      status: "undeclared",
      detail: derived.length ? `pre-contract manifest; modules hold: ${derived.map(p => p.tool || p.capability).join(", ")}` : "pre-contract manifest; no module grants",
    });
  }

  // Dependencies: a missing required dependency is a component failure; an
  // installed-but-unready or unhealthy one degrades; optional gaps inform.
  for (const resolution of packDependencies.resolveDependencies(record.manifest).resolutions) {
    const dependencyRecord = resolution.installed ? repository.getPack(resolution.name) : null;
    const lastHealth = dependencyRecord?.health?.status || null;
    let ok = true;
    let detail;
    if (!resolution.installed) {
      ok = resolution.optional;
      detail = "not installed";
      if (!resolution.optional) escalate(HEALTH_STATUS.COMPONENT_FAILURE);
    } else if (!resolution.satisfied) {
      ok = resolution.optional;
      detail = resolution.problem;
      if (!resolution.optional) escalate(HEALTH_STATUS.DEGRADED);
    } else if (enabled && !resolution.optional && resolution.state !== "enabled") {
      ok = false;
      detail = `installed but ${resolution.state}`;
      escalate(HEALTH_STATUS.DEGRADED);
    } else if (enabled && !resolution.optional && lastHealth && lastHealth !== "healthy") {
      ok = false;
      detail = `enabled but last health was ${lastHealth}`;
      escalate(HEALTH_STATUS.DEGRADED);
    } else {
      detail = `${resolution.installed_version} (${resolution.state})`;
    }
    components.push({
      component: resolution.name,
      kind: "dependency",
      ok,
      status: resolution.installed ? resolution.state : "missing",
      optional: resolution.optional,
      detail: resolution.requires_version ? `${detail}; requires ${resolution.requires_version}` : detail,
    });
  }

  for (const component of repository.listComponents(record.name, { kind: "workflow" })) {
    const definition = workflowRepository.getWorkflowDefinition(component.ref);
    const expected = enabled ? "registered" : "disabled";
    const ok = Boolean(definition) && definition.state === expected;
    components.push({
      component: component.ref,
      kind: "workflow",
      ok,
      status: definition ? definition.state : "missing",
      detail: definition ? `${definition.state} (v${definition.version})` : "definition missing",
    });
    if (!ok) escalate(HEALTH_STATUS.COMPONENT_FAILURE);
  }

  for (const component of repository.listComponents(record.name, { kind: "knowledge" })) {
    const asset = component.detail?.knowledge_id ? packKnowledge.getAsset(component.detail.knowledge_id) : null;
    const ok = Boolean(asset) && Boolean(asset.enabled) === enabled;
    components.push({
      component: component.ref,
      kind: "knowledge",
      ok,
      status: asset ? (asset.enabled ? "enabled" : "disabled") : "missing",
      detail: asset ? `${asset.category} (id ${asset.id})` : "knowledge row missing",
    });
    if (!asset) escalate(HEALTH_STATUS.COMPONENT_FAILURE);
    else if (!ok) escalate(HEALTH_STATUS.DEGRADED);
  }

  const optionalMissing = (record.manifest.requires?.optional_tools || []).filter(tool => !toolAvailable(tool));
  if (optionalMissing.length) {
    components.push({ component: "optional_tools", kind: "pack", ok: true, status: "partial", detail: `unavailable: ${optionalMissing.join(", ")}` });
  }
  const requiredMissing = (record.manifest.requires?.tools || []).filter(tool => !toolAvailable(tool));
  if (requiredMissing.length) {
    components.push({ component: "required_tools", kind: "pack", ok: false, status: "missing", detail: requiredMissing.join(", ") });
    escalate(HEALTH_STATUS.COMPONENT_FAILURE);
  }

  let status = worst;
  if (status === null || status === HEALTH_STATUS.HEALTHY) status = enabled ? HEALTH_STATUS.HEALTHY : HEALTH_STATUS.DISABLED;
  // A disabled pack whose components are correctly parked is healthy-for-
  // disabled, not "unhealthy": report DISABLED unless something is actually wrong.
  if (!enabled && (status === HEALTH_STATUS.DEGRADED || status === HEALTH_STATUS.DISABLED)) status = HEALTH_STATUS.DISABLED;

  const categoryFor = component => {
    if (component.component === "compatibility" || component.component === "pack_api") return "compatibility";
    if (component.component === "configuration") return "configuration";
    if (component.component === "permissions") return "authorization";
    if (component.kind === "dependency") return "dependencies";
    if (component.kind === "module" && /integrity|missing/i.test(`${component.status} ${component.detail}`)) return "integrity";
    return "components";
  };
  const categories = {};
  for (const component of components) {
    const category = categoryFor(component);
    if (!categories[category]) categories[category] = { ok: true, failures: 0, components: [] };
    categories[category].components.push(component.component);
    if (!component.ok) {
      categories[category].ok = false;
      categories[category].failures += 1;
    }
  }

  return {
    name: record.name,
    display_name: record.display_name,
    version: record.version,
    state: record.state,
    provenance: record.provenance,
    status,
    ok: status === HEALTH_STATUS.HEALTHY || (status === HEALTH_STATUS.DISABLED && !enabled),
    package_hash: record.package_hash,
    install_path: record.install_path,
    components,
    categories,
    optional_tools_unavailable: optionalMissing,
    error: record.error || null,
    checked_at: new Date().toISOString(),
  };
}

function toolAvailable(name) {
  try {
    if (require("../tools").getBuiltinRegistry().has(name)) return true;
  } catch {}
  try {
    return Boolean(require("../db").getGeneratedCapabilityByName(name));
  } catch {
    return false;
  }
}

/** Produce an operator-oriented repair report without mutating the pack. */
function doctor(name) {
  const report = health(name);
  const actions = [];
  for (const component of report.components.filter(entry => entry.ok === false)) {
    if (component.kind === "dependency") actions.push({ component: component.component, action: "install or enable the required dependency" });
    else if (component.component === "configuration") actions.push({ component: component.component, action: "update the pack configuration to satisfy its schema" });
    else if (component.component === "permissions") actions.push({ component: component.component, action: "align pack permissions with the owned module manifests" });
    else if (component.kind === "module") actions.push({ component: component.component, action: "inspect module health and repair integrity/configuration before enabling" });
    else if (component.kind === "workflow") actions.push({ component: component.component, action: "re-register or upgrade the workflow definition" });
    else if (component.kind === "knowledge") actions.push({ component: component.component, action: "restore the owned knowledge row or reinstall the pack" });
    else actions.push({ component: component.component, action: "inspect the component detail and correct the reported condition" });
  }
  return { ok: report.ok, status: report.status, checked_at: report.checked_at, health: report, actions };
}

/** Operator-facing summary of one installed pack. */
function describe(name, { includeHealth = true } = {}) {
  const record = repository.getPack(name);
  if (!record) return null;
  const components = repository.listComponents(name);
  const modules = components.filter(c => c.kind === "module");
  const tools = [];
  for (const component of modules) {
    for (const tool of component.detail?.tools || []) tools.push(tool);
  }
  return {
    name: record.name,
    display_name: record.display_name,
    version: record.version,
    description: record.description,
    publisher: record.publisher,
    provenance: record.provenance,
    bundled: record.source?.kind === "bundled",
    state: record.state,
    enabled: record.state === "enabled",
    installed_at: record.installed_at,
    package_hash: record.package_hash,
    install_path: record.install_path,
    compatibility: record.compatibility,
    pack_api: checkPackApi(record.manifest).pack_api,
    permissions: describePermissions(record),
    depends: {
      declared: (record.manifest.depends?.packs || []).map(d => ({ ...d })),
      resolutions: packDependencies.resolveDependencies(record.manifest).resolutions,
      dependents: packDependencies.listRequiredDependents(record.name).map(p => p.name),
    },
    configuration: {
      schema: record.manifest.configuration?.schema || null,
      values: record.config,
      valid: validatePackConfig(record.manifest, record.config).ok,
    },
    modules: modules.map(c => ({ name: c.ref, version: c.version, state: c.state, tools: c.detail?.tools || [] })),
    tools,
    workflows: components.filter(c => c.kind === "workflow").map(c => ({ name: c.ref, version: c.version, state: c.state, title: c.detail?.title, mode: c.detail?.mode })),
    knowledge: components.filter(c => c.kind === "knowledge").map(c => ({ title: c.ref, state: c.state, category: c.detail?.category })),
    requires: record.manifest.requires || { tools: [], optional_tools: [] },
    health: includeHealth ? health(name) : record.health,
    error: record.error || null,
  };
}

function describePermissions(record) {
  const moduleManifests = repository
    .listComponents(record.name, { kind: "module" })
    .map(component => moduleRepository.getModule(component.ref)?.manifest)
    .filter(Boolean);
  const comparison = comparePackPermissions(record.manifest.permissions, moduleManifests);
  return {
    declared: record.manifest.permissions ? record.manifest.permissions.map(p => ({ ...p })) : null,
    derived: comparison.aggregate.map(p => ({ ...p })),
    consistent: record.manifest.permissions ? comparison.ok : null,
  };
}

/**
 * Structured validation of a pack package for authors and operators.
 *
 * Unlike inspect (which throws on a malformed manifest), validate always
 * returns a report: every finding names the file, the field where one applies,
 * the problem, and the correction. Nothing is installed or executed.
 */
function validate(sourcePath) {
  const findings = [];
  const finding = (severity, area, problem, { file = null, field = null, correction = null } = {}) => {
    findings.push({ severity, area, file, field, problem, correction });
  };

  const root = path.resolve(sourcePath);
  const manifestPath = path.join(root, PACK_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    finding("error", "manifest", `no ${PACK_MANIFEST_FILENAME} found`, {
      file: PACK_MANIFEST_FILENAME,
      correction: `create a ${PACK_MANIFEST_FILENAME} at the package root (see docs/capability-packs.md)`,
    });
    return { valid: false, path: root, findings, summary: summarizeFindings(findings) };
  }

  let rawManifest;
  try {
    // Guarded read: symlink refusal, size bound, sanitized parse errors — the
    // same rules inspect applies, so validate is never a weaker read path.
    rawManifest = readPackManifestFile(manifestPath);
  } catch (error) {
    finding("error", "manifest", error.message, {
      file: PACK_MANIFEST_FILENAME,
      correction: "fix the JSON syntax",
    });
    return { valid: false, path: root, findings, summary: summarizeFindings(findings) };
  }

  const parsed = packManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      finding("error", "manifest", issue.message, {
        file: PACK_MANIFEST_FILENAME,
        field: issue.path.join(".") || null,
        correction: manifestCorrectionHint(issue),
      });
    }
    return { valid: false, path: root, findings, summary: summarizeFindings(findings) };
  }

  let inspection = null;
  try {
    inspection = inspectPackPackage(root);
  } catch (error) {
    finding("error", "package", error.message, { file: PACK_MANIFEST_FILENAME });
    return { valid: false, path: root, findings, summary: summarizeFindings(findings) };
  }

  for (const problem of inspection.problems) {
    finding("error", classifyInspectionProblem(problem), problem, { file: PACK_MANIFEST_FILENAME });
  }
  if (!inspection.manifest.permissions && inspection.permissions.derived.length) {
    finding(
      "warning",
      "permissions",
      "manifest declares no pack-level permissions but its modules hold tool grants",
      {
        file: PACK_MANIFEST_FILENAME,
        field: "permissions",
        correction: `declare: ${JSON.stringify(inspection.permissions.derived)}`,
      }
    );
  }

  return {
    valid: findings.every(entry => entry.severity !== "error"),
    path: root,
    name: inspection.name,
    version: inspection.version,
    pack_api: inspection.pack_api,
    package_hash: inspection.package_hash,
    findings,
    summary: summarizeFindings(findings),
  };
}

function summarizeFindings(findings) {
  const errors = findings.filter(entry => entry.severity === "error").length;
  const warnings = findings.filter(entry => entry.severity === "warning").length;
  return { errors, warnings };
}

function manifestCorrectionHint(issue) {
  const field = issue.path.join(".");
  if (field === "name") return "use a lowercase identifier matching ^[a-z][a-z0-9-]*$";
  if (field.startsWith("permissions")) return 'each permission is {"tool": "<name>", "risk": "low|medium|high|critical"} or {"capability": "<name>"}';
  if (field.startsWith("depends")) return 'each dependency is {"name": "<pack>", "version": "<range, optional>", "optional": true|false}';
  if (field === "pack_api") return "declare a positive integer Pack API version (current: 1)";
  if (field.startsWith("modules")) return "each module is {\"name\", \"path\", optional \"entry_point\", optional \"config_from_pack\"}";
  return "see the manifest reference in docs/capability-packs.md";
}

function classifyInspectionProblem(problem) {
  if (problem.startsWith("module ")) return "modules";
  if (problem.startsWith("workflow ")) return "workflows";
  if (problem.startsWith("knowledge ")) return "knowledge";
  if (problem.includes("dependency") || problem.includes("dependency cycle") || problem.startsWith("Pack dependency")) return "dependencies";
  if (problem.includes("pack_api")) return "compatibility";
  if (problem.includes("Sidekick")) return "compatibility";
  if (problem.includes("permission")) return "permissions";
  if (problem.includes("required tool")) return "requires";
  return "package";
}

module.exports = { HEALTH_STATUS, inspect, install, configure, enable, disable, upgrade, uninstall, health, doctor, describe, validate };
