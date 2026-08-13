"use strict";

/**
 * Module package inspection (B9).
 *
 * Inspection is the safe, read-only step that must be possible BEFORE any
 * third-party code is executed. It reads the manifest as data, walks the file
 * tree, computes a deterministic whole-package hash, and answers the questions
 * an operator (or the installer) needs in order to decide whether the package
 * may be installed at all:
 *
 *   identity, version, manifest, declared entry point, files, package hash,
 *   compatibility requirements, contributed tools, configuration requirements,
 *   provenance of the source path.
 *
 * Nothing here requires, imports or evaluates package code. The only files read
 * are read as bytes for hashing and as JSON for the manifest.
 *
 * Rejections are deliberate and fail closed: path traversal, symlinks, entry
 * points that escape the package root, malformed manifests, invalid versions,
 * duplicate module identity, descriptor collisions with the live registry, and
 * files the packaging policy forbids (secrets/keys).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MANIFEST_FILENAMES } = require("./discovery");
const { parseManifestFile, satisfiesVersion, checkManifestOwnership } = require("./manifest");
const { stripSidekickPrefix } = require("../core/tool-name");

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const SENSITIVE_FILE_RE = /(^|\/)(?:\.env(?:\..*)?|.*\.pem|.*\.key|.*\.p12|credentials\.json|secrets?\.json)$/i;
const MAX_PACKAGE_FILES = 2000;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

function sidekickVersion() {
  try {
    return require("../../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function collectFiles(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    // Symlinks are refused rather than followed: a link is the simplest way to
    // smuggle bytes that the package hash does not cover into the runtime
    // installation.
    if (entry.isSymbolicLink()) throw new Error(`Module package contains a symlink: ${path.relative(root, fullPath)}`);
    if (entry.isDirectory()) collectFiles(root, fullPath, files);
    else if (entry.isFile()) files.push(fullPath);
    else throw new Error(`Module package contains a non-regular file: ${path.relative(root, fullPath)}`);
    if (files.length > MAX_PACKAGE_FILES) throw new Error(`Module package exceeds ${MAX_PACKAGE_FILES} files`);
  }
  return files;
}

/**
 * Resolve the declared entry point inside the package root.
 *
 * The check is on the RESOLVED path, so `../`, an absolute path, and a path
 * that leaves the root through any intermediate component are all refused —
 * this is the guard that keeps `entry_point` from becoming "require anything
 * on the server".
 */
function resolveEntryPoint(root, entryPoint) {
  const declared = String(entryPoint || "entry.js");
  if (path.isAbsolute(declared)) throw new Error(`Module entry point must be relative to the package root: ${declared}`);
  if (declared.split(/[\\/]/).includes("..")) throw new Error(`Module entry point must not traverse outside the package root: ${declared}`);
  const absolute = path.resolve(root, declared);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Module entry point escapes the package root: ${declared}`);
  if (!fs.existsSync(absolute)) throw new Error(`Module entry point not found in package: ${declared}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Module entry point must be a regular file: ${declared}`);
  return { absolute, relative: path.relative(root, absolute).split(path.sep).join("/") };
}

/** Deterministic whole-package hash over (relative path, content hash) pairs. */
function packageHashOf(entries) {
  return crypto
    .createHash("sha256")
    .update(entries.map(entry => `${entry.path}\0${entry.sha256}\n`).join(""), "utf8")
    .digest("hex");
}

/**
 * Build a deterministic, non-archiving package manifest for review/signing.
 * Retained under its original name and shape: existing callers and
 * test/modules-packaging.test.js depend on it.
 */
function inspectModulePackage(moduleRoot) {
  const root = fs.realpathSync(path.resolve(moduleRoot));
  const manifestName = MANIFEST_FILENAMES.find(name => fs.existsSync(path.join(root, name)));
  if (!manifestName) throw new Error(`Module package has no manifest (${MANIFEST_FILENAMES.join(" or ")})`);
  const manifest = parseManifestFile(path.join(root, manifestName));
  const files = collectFiles(root).sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
  let totalBytes = 0;
  const entries = files.map(filePath => {
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    if (SENSITIVE_FILE_RE.test(relativePath)) throw new Error(`Module package contains a sensitive file: ${relativePath}`);
    const content = fs.readFileSync(filePath);
    totalBytes += content.length;
    if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`Module package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    return { path: relativePath, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  });
  return Object.freeze({
    format: "sidekick-module-package-v1",
    name: manifest.name,
    version: manifest.version,
    manifest_file: manifestName,
    files: entries,
    package_hash: packageHashOf(entries),
  });
}

/**
 * Recompute the whole-package hash of an installed directory.
 *
 * This is the integrity check run before third-party code is loaded. It walks
 * the installation with the same rules as inspection, so a file added, removed
 * or edited after install changes the hash and the module fails closed.
 */
function hashInstalledPackage(installPath) {
  const root = fs.realpathSync(path.resolve(installPath));
  const files = collectFiles(root).sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
  const entries = files.map(filePath => ({
    path: path.relative(root, filePath).split(path.sep).join("/"),
    sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
  }));
  return { package_hash: packageHashOf(entries), file_count: entries.length };
}

/**
 * Full pre-install inspection: everything inspectModulePackage returns, plus
 * the entry point, compatibility verdict, contributed tools, configuration
 * requirements, provenance, and the fail-closed reasons an install would be
 * refused for.
 *
 * `options.installedModules` / `options.registry` let the caller supply the
 * live collision context; by default the live registry is consulted, so
 * inspection reports a built-in shadowing attempt before any install occurs.
 */
function inspectPackageForInstall(sourcePath, options = {}) {
  const root = fs.realpathSync(path.resolve(sourcePath));
  const base = inspectModulePackage(root);
  const manifestPath = path.join(root, base.manifest_file);
  const manifest = parseManifestFile(manifestPath);

  const problems = [];
  let entry = null;
  try {
    entry = resolveEntryPoint(root, options.entryPoint || manifest.entryPoint || "entry.js");
  } catch (error) {
    problems.push(error.message);
  }
  if (entry && !base.files.some(file => file.path === entry.relative)) {
    problems.push(`Module entry point "${entry.relative}" is not part of the inspected package`);
  }

  const currentSidekick = options.sidekickVersion || sidekickVersion();
  const compatible = manifest.sidekick ? satisfiesVersion(currentSidekick, manifest.sidekick) : true;
  if (!compatible) {
    problems.push(`Module requires Sidekick ${manifest.sidekick} but this Sidekick is ${currentSidekick}`);
  }

  const collisions = collisionContext(options);
  const ownership = checkManifestOwnership(manifest, collisions);
  if (!ownership.ok) problems.push(...ownership.errors);

  const configurationRequired = requiredConfigKeys(manifest);

  return Object.freeze({
    format: base.format,
    name: base.name,
    display_name: manifest.displayName || null,
    version: base.version,
    description: manifest.description,
    author: manifest.author || null,
    type: manifest.type,
    manifest,
    manifest_file: base.manifest_file,
    entry_point: entry ? entry.relative : null,
    files: base.files,
    file_count: base.files.length,
    package_hash: base.package_hash,
    compatibility: Object.freeze({
      requires: manifest.sidekick || null,
      sidekick_version: currentSidekick,
      compatible,
    }),
    tools: Object.freeze(Object.keys(manifest.tools).map(name => Object.freeze({
      name: stripSidekickPrefix(name),
      risk: manifest.tools[name].risk,
      category: manifest.tools[name].category || null,
      aliases: Object.freeze([...(manifest.tools[name].aliases || [])]),
    }))),
    capabilities: Object.freeze([...manifest.capabilities]),
    permissions: Object.freeze(manifest.permissions.map(p => Object.freeze({ ...p }))),
    configuration: Object.freeze({
      schema: manifest.configSchema || null,
      required: Object.freeze(configurationRequired),
      required_before_enable: configurationRequired.length > 0,
    }),
    migrations: Object.freeze(manifest.migrations.map(m => m.name)),
    source: Object.freeze({ kind: options.sourceKind || "local_path", path: root, inspected_at: new Date().toISOString() }),
    installable: problems.length === 0,
    problems: Object.freeze(problems),
  });
}

function requiredConfigKeys(manifest) {
  const schema = manifest.configSchema;
  if (!schema || typeof schema !== "object" || !Array.isArray(schema.required)) return [];
  return [...schema.required].map(String);
}

/**
 * Build the collision context from the live tool surface unless the caller
 * supplies one. Generated (dynamic) capability names are included by
 * liveRegistrySnapshot semantics through the loader; here we consult the
 * builtin registry plus the generated capability list directly so inspection
 * can run without activating anything.
 */
function collisionContext(options = {}) {
  if (options.registry) return options.registry;
  const toolNames = [];
  const aliases = [];
  try {
    for (const descriptor of require("../tools").getBuiltinRegistry().listInDefinitionOrder()) {
      toolNames.push(stripSidekickPrefix(descriptor.name));
      for (const alias of descriptor.aliases || []) aliases.push(stripSidekickPrefix(alias));
    }
  } catch {}
  try {
    for (const capability of require("../db").listGeneratedCapabilities()) {
      if (capability?.name) toolNames.push(stripSidekickPrefix(capability.name));
    }
  } catch {}
  let installedModules = options.installedModules;
  if (!installedModules) {
    try {
      installedModules = require("./repository").listModules().map(record => record.name);
    } catch {
      installedModules = [];
    }
  }
  return { toolNames, aliases, installedModules };
}

module.exports = {
  inspectModulePackage,
  inspectPackageForInstall,
  hashInstalledPackage,
  packageHashOf,
  resolveEntryPoint,
  sidekickVersion,
  SENSITIVE_FILE_RE,
};
