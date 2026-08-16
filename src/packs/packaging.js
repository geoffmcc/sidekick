"use strict";

/**
 * Capability-pack package inspection.
 *
 * Same discipline as module package inspection (src/modules/packaging.js) and
 * for the same reason: an operator — and the installer — must be able to see
 * exactly what a pack contains, and get a stable integrity hash, BEFORE any of
 * its code is copied into the runtime or executed.
 *
 * Inspection recursively inspects the pack's owned MODULE packages too, so a
 * pack cannot smuggle in a module that would be refused on its own.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PACK_MANIFEST_FILENAME, parsePackManifestFile, checkPackCompatibility, checkPackApi, comparePackPermissions } = require("./manifest");
const packDependencies = require("./dependencies");
const modulePackaging = require("../modules/packaging");
const { normalizeDefinition } = require("../workflows/definition");

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const MAX_PACK_FILES = 5000;
const MAX_PACK_BYTES = 64 * 1024 * 1024;

function collectFiles(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Capability pack contains a symlink: ${path.relative(root, fullPath)}`);
    if (entry.isDirectory()) collectFiles(root, fullPath, files);
    else if (entry.isFile()) files.push(fullPath);
    else throw new Error(`Capability pack contains a non-regular file: ${path.relative(root, fullPath)}`);
    if (files.length > MAX_PACK_FILES) throw new Error(`Capability pack exceeds ${MAX_PACK_FILES} files`);
  }
  return files;
}

function hashFiles(root) {
  const files = collectFiles(root).sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
  let totalBytes = 0;
  const entries = files.map(filePath => {
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    if (modulePackaging.SENSITIVE_FILE_RE.test(relative)) throw new Error(`Capability pack contains a sensitive file: ${relative}`);
    const content = fs.readFileSync(filePath);
    totalBytes += content.length;
    if (totalBytes > MAX_PACK_BYTES) throw new Error(`Capability pack exceeds ${MAX_PACK_BYTES} bytes`);
    return { path: relative, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  });
  return { entries, package_hash: modulePackaging.packageHashOf(entries) };
}

/** Resolve a manifest-declared relative path, refusing anything outside the pack. */
function resolveInside(root, relative, label) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Capability pack ${label} escapes the pack root: ${relative}`);
  if (!fs.existsSync(absolute)) throw new Error(`Capability pack ${label} not found: ${relative}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Capability pack ${label} is a symlink: ${relative}`);
  return absolute;
}

/** Recompute the whole-package hash of an installed pack directory. */
function hashInstalledPack(installPath) {
  const root = fs.realpathSync(path.resolve(installPath));
  const { entries, package_hash } = hashFiles(root);
  return { package_hash, file_count: entries.length };
}

/**
 * Inspect a pack package.
 *
 * Returns everything needed to decide installability, including per-module
 * inspection results and per-workflow validation results. `installable` is
 * false whenever ANY component would be refused — a partially installable pack
 * is not installed at all.
 */
function inspectPackPackage(sourcePath, options = {}) {
  const root = fs.realpathSync(path.resolve(sourcePath));
  const manifestPath = path.join(root, PACK_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) throw new Error(`Capability pack has no ${PACK_MANIFEST_FILENAME}`);
  const manifest = parsePackManifestFile(manifestPath);

  const { entries, package_hash } = hashFiles(root);
  const problems = [];
  const sidekickVersion = options.sidekickVersion || modulePackaging.sidekickVersion();
  const compatibility = checkPackCompatibility(manifest, sidekickVersion);
  if (!compatibility.ok) {
    problems.push(`Pack requires Sidekick ${compatibility.requires} but this Sidekick is ${sidekickVersion}`);
  }
  const packApi = checkPackApi(manifest);
  if (!packApi.ok) {
    problems.push(`Pack declares pack_api ${packApi.pack_api} but this Sidekick supports pack_api ${packApi.supported.join(", ")}`);
  }

  // Dependencies: a required dependency that is missing, version-incompatible
  // or cyclic is refused here — before any file is copied — with the same
  // fail-closed posture as every other component check. The repository view is
  // injectable so inspection of a candidate can be tested without a live DB.
  const dependencyView = options.packContext || {};
  const dependencyResolution = packDependencies.resolveDependencies(manifest, dependencyView);
  problems.push(...dependencyResolution.problems);
  const dependencyCycle = packDependencies.findDependencyCycle(manifest, dependencyView);
  if (dependencyCycle) {
    problems.push(`Pack dependency cycle: ${dependencyCycle.join(" -> ")}`);
  }

  // Modules: inspected with the module rules, so descriptor collisions,
  // traversal and packaging violations surface here rather than mid-install.
  const modules = [];
  // An UPGRADE inspects a candidate while the pack it replaces is still
  // installed and possibly live. Its own modules, tools and aliases must not
  // be reported as conflicting with themselves, so both the installed-module
  // list and the live descriptor snapshot are filtered to exclude what this
  // pack already owns. Everything else still fails closed.
  const replacing = options.replacingPack === manifest.name ? manifest.name : null;
  const excludeSelf = new Set(replacing ? manifest.modules.map(m => m.name) : []);
  const registryContext = replacing ? registryExcludingPackModules(excludeSelf) : options.registry;
  for (const reference of manifest.modules) {
    try {
      const moduleRoot = resolveInside(root, reference.path, `module "${reference.name}"`);
      const inspection = modulePackaging.inspectPackageForInstall(moduleRoot, {
        entryPoint: reference.entry_point,
        sidekickVersion,
        sourceKind: "capability_pack",
        installedModules: (options.installedModules || currentModuleNames()).filter(name => !excludeSelf.has(name)),
        registry: registryContext,
      });
      if (inspection.name !== reference.name) {
        problems.push(`Pack declares module "${reference.name}" but its package is "${inspection.name}"`);
      }
      if (!inspection.installable) {
        problems.push(...inspection.problems.map(problem => `module ${reference.name}: ${problem}`));
      }
      modules.push({ reference, inspection, module_root: moduleRoot });
    } catch (error) {
      problems.push(`module ${reference.name}: ${error.message}`);
    }
  }

  // Permissions: when the pack declares them, the declaration must agree
  // EXACTLY with the aggregate its modules hold — in both directions. The
  // module-level allowlist is what enforces dispatch; this check makes the
  // pack manifest a truthful, reviewable statement of that enforcement. A
  // manifest with no `permissions` key is a pre-contract pack: accepted, and
  // reported as undeclared rather than silently equated with "none".
  const inspectedModuleManifests = modules.map(entry => entry.inspection?.manifest).filter(Boolean);
  const permissionComparison = comparePackPermissions(manifest.permissions, inspectedModuleManifests);
  if (manifest.permissions) {
    if (permissionComparison.missing.length) {
      problems.push(`Pack permissions omit module-held grants: ${permissionComparison.missing.join(", ")}`);
    }
    if (permissionComparison.extra.length) {
      problems.push(`Pack permissions declare grants no module holds: ${permissionComparison.extra.join(", ")}`);
    }
  }

  // Workflows: validated as definitions now, so a broken definition cannot be
  // discovered only when an operator tries to run it.
  const workflows = [];
  for (const reference of manifest.workflows) {
    try {
      const workflowPath = resolveInside(root, reference.path, `workflow "${reference.path}"`);
      const definition = normalizeDefinition(JSON.parse(fs.readFileSync(workflowPath, "utf-8")));
      workflows.push({ reference, definition, path: workflowPath });
    } catch (error) {
      problems.push(`workflow ${reference.path}: ${error.message}`);
    }
  }
  const workflowNames = new Set();
  for (const entry of workflows) {
    if (workflowNames.has(entry.definition.name)) problems.push(`Pack declares workflow "${entry.definition.name}" twice`);
    workflowNames.add(entry.definition.name);
  }

  const knowledge = [];
  for (const reference of manifest.knowledge) {
    try {
      const assetPath = resolveInside(root, reference.path, `knowledge "${reference.path}"`);
      const content = fs.readFileSync(assetPath, "utf-8");
      if (!content.trim()) throw new Error("knowledge asset is empty");
      knowledge.push({ reference, path: assetPath, bytes: Buffer.byteLength(content) });
    } catch (error) {
      problems.push(`knowledge ${reference.path}: ${error.message}`);
    }
  }

  // Tools contributed by the pack's OWN modules do not exist yet at inspection
  // time; requiring one of them is legitimate and must not read as "missing".
  const packOwnedTools = new Set();
  for (const entry of modules) {
    for (const tool of entry.inspection ? entry.inspection.tools : []) {
      packOwnedTools.add(tool.name);
      for (const alias of tool.aliases || []) packOwnedTools.add(alias);
    }
  }
  const toolAvailability = checkRequiredTools(manifest, { ...options, packOwnedTools });
  problems.push(...toolAvailability.missing.map(tool => `required tool "${tool}" is not available in this Sidekick`));

  return Object.freeze({
    format: "sidekick-capability-pack-v1",
    name: manifest.name,
    display_name: manifest.display_name,
    version: manifest.version,
    description: manifest.description,
    publisher: manifest.publisher,
    manifest,
    files: entries,
    file_count: entries.length,
    package_hash,
    pack_api: Object.freeze({
      declared: packApi.pack_api,
      supported: Object.freeze(packApi.supported),
      compatible: packApi.ok,
    }),
    compatibility: Object.freeze({
      requires: compatibility.requires,
      sidekick_version: compatibility.sidekick_version,
      compatible: compatibility.ok,
    }),
    permissions: Object.freeze({
      declared: manifest.permissions ? Object.freeze(manifest.permissions.map(p => Object.freeze({ ...p }))) : null,
      derived: Object.freeze(permissionComparison.aggregate.map(p => Object.freeze({ ...p }))),
      consistent: manifest.permissions ? permissionComparison.ok : null,
    }),
    dependencies: Object.freeze({
      declared: Object.freeze(manifest.depends.packs.map(d => Object.freeze({ ...d }))),
      resolutions: Object.freeze(dependencyResolution.resolutions.map(r => Object.freeze({ ...r }))),
      cycle: dependencyCycle ? Object.freeze([...dependencyCycle]) : null,
      ok: dependencyResolution.ok && !dependencyCycle,
    }),
    modules: Object.freeze(modules.map(m => Object.freeze({
      name: m.reference.name,
      path: m.reference.path,
      version: m.inspection ? m.inspection.version : null,
      tools: m.inspection ? m.inspection.tools.map(t => t.name) : [],
      config_from_pack: m.reference.config_from_pack,
      module_root: m.module_root,
      installable: m.inspection ? m.inspection.installable : false,
      problems: m.inspection ? m.inspection.problems : [],
    }))),
    workflows: Object.freeze(workflows.map(w => Object.freeze({
      name: w.definition.name,
      version: w.definition.version,
      title: w.definition.title,
      mode: w.definition.mode,
      steps: w.definition.steps.length,
      path: w.reference.path,
    }))),
    knowledge: Object.freeze(knowledge.map(k => Object.freeze({
      title: k.reference.title,
      category: k.reference.category,
      path: k.reference.path,
      bytes: k.bytes,
    }))),
    requires: Object.freeze({
      tools: Object.freeze([...manifest.requires.tools]),
      optional_tools: Object.freeze([...manifest.requires.optional_tools]),
      missing: Object.freeze(toolAvailability.missing),
      optional_missing: Object.freeze(toolAvailability.optionalMissing),
    }),
    configuration: Object.freeze({
      schema: manifest.configuration.schema || null,
      defaults: Object.freeze({ ...manifest.configuration.defaults }),
    }),
    source: Object.freeze({ kind: options.sourceKind || "local_path", path: root, inspected_at: new Date().toISOString() }),
    installable: problems.length === 0,
    problems: Object.freeze(problems),
    // Retained (unfrozen references) for the installer; not part of the
    // operator-facing surface.
    _components: { modules, workflows, knowledge, root },
  });
}

/**
 * Live collision context with the named modules' contributions removed.
 * `source` on a module descriptor is `module:<name>`, which is how a
 * descriptor is attributed back to the module that registered it.
 */
function registryExcludingPackModules(moduleNames) {
  const { stripSidekickPrefix } = require("../core/tool-name");
  const toolNames = [];
  const aliases = [];
  try {
    for (const descriptor of require("../tools").getBuiltinRegistry().listInDefinitionOrder()) {
      const owner = typeof descriptor.source === "string" && descriptor.source.startsWith("module:")
        ? descriptor.source.slice("module:".length)
        : null;
      if (owner && moduleNames.has(owner)) continue;
      toolNames.push(stripSidekickPrefix(descriptor.name));
      for (const alias of descriptor.aliases || []) aliases.push(stripSidekickPrefix(alias));
    }
  } catch {}
  try {
    for (const capability of require("../db").listGeneratedCapabilities()) {
      if (capability?.name) toolNames.push(stripSidekickPrefix(capability.name));
    }
  } catch {}
  return { toolNames, aliases, installedModules: [] };
}

function currentModuleNames() {
  try {
    return require("../modules/repository").listModules().map(record => record.name);
  } catch {
    return [];
  }
}

function checkRequiredTools(manifest, options = {}) {
  const packOwnedTools = options.packOwnedTools || new Set();
  let has = options.hasTool;
  if (typeof has !== "function") {
    let registry = null;
    try {
      registry = require("../tools").getBuiltinRegistry();
    } catch {}
    has = name => {
      if (registry && registry.has(name)) return true;
      try {
        return Boolean(require("../db").getGeneratedCapabilityByName(name));
      } catch {
        return false;
      }
    };
  }
  const available = name => packOwnedTools.has(name) || has(name);
  return {
    missing: manifest.requires.tools.filter(tool => !available(tool)),
    optionalMissing: manifest.requires.optional_tools.filter(tool => !available(tool)),
  };
}

module.exports = { inspectPackPackage, hashInstalledPack, resolveInside, hashFiles };
