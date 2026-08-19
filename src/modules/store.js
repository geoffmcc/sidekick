"use strict";

/**
 * Managed module package store (B9).
 *
 * An installed third-party module NEVER runs from the directory the operator
 * pointed at. Installation copies the reviewed package into a Sidekick-managed
 * location under the data directory:
 *
 *   <SIDEKICK_DATA_DIR>/modules/<module-name>/<version>/
 *
 * Staging (upgrades) uses a sibling directory that is only swapped in after the
 * candidate verifies, so a failed upgrade never destroys the working install:
 *
 *   <SIDEKICK_DATA_DIR>/modules/<module-name>/.staging-<random>/
 *
 * Owning the runtime location is what makes the integrity model meaningful:
 * the whole-package hash recorded at install time is recomputed against these
 * bytes before any entry point is loaded, and the operator's source tree can
 * change afterwards without silently changing what Sidekick executes.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MODULE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_DIR_RE = /^[0-9A-Za-z.\-+]+$/;

function dataDir() {
  return process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");
}

/** Root of the managed module store. Created on demand. */
function moduleStoreRoot() {
  return path.resolve(dataDir(), "modules");
}

function assertSafeName(name) {
  if (!MODULE_NAME_RE.test(String(name || ""))) throw new Error(`Invalid module name for the managed store: ${name}`);
  return String(name);
}

function assertSafeVersion(version) {
  const value = String(version || "");
  if (!VERSION_DIR_RE.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid module version for the managed store: ${version}`);
  }
  return value;
}

function moduleDir(name) {
  return path.join(moduleStoreRoot(), assertSafeName(name));
}

function versionDir(name, version) {
  return path.join(moduleDir(name), assertSafeVersion(version));
}

/**
 * True when `candidate` resolves inside the managed store. Used as a guard
 * before anything is loaded from or deleted at a recorded install path: a
 * tampered `install_path` column must not turn module loading into arbitrary
 * file execution, or uninstall into arbitrary recursive deletion.
 */
function isManagedPath(candidate) {
  if (!candidate) return false;
  const root = moduleStoreRoot();
  const resolved = path.resolve(String(candidate));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;

  // Lexical containment is not sufficient: a tampered install path can place
  // a symlinked ancestor under the managed root while resolving outside it.
  // Canonicalize the nearest existing ancestor so nonexistent staging targets
  // receive the same protection as existing installations.
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  let canonicalRoot;
  let canonicalExisting;
  try {
    canonicalRoot = fs.realpathSync(root);
    canonicalExisting = fs.realpathSync(existing);
  } catch {
    return false;
  }
  const canonicalRelative = path.relative(canonicalRoot, canonicalExisting);
  return Boolean(canonicalRelative) && !canonicalRelative.startsWith("..") && !path.isAbsolute(canonicalRelative);
}

function ensureStoreRoot() {
  const root = moduleStoreRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Copy a reviewed package into a fresh directory. `files` is the relative file
 * list produced by package inspection, so ONLY inspected (and therefore
 * hashed) files are ever copied — a file that appeared after inspection is not
 * carried into the managed installation.
 */
function materialize(sourceRoot, targetDir, files) {
  const resolvedSource = fs.realpathSync(path.resolve(sourceRoot));
  fs.mkdirSync(targetDir, { recursive: true });
  for (const relative of files) {
    const from = path.resolve(resolvedSource, relative);
    if (!from.startsWith(`${resolvedSource}${path.sep}`)) {
      throw new Error(`Refusing to copy a package file outside the package root: ${relative}`);
    }
    const stat = fs.lstatSync(from);
    if (!stat.isFile()) throw new Error(`Package file is not a regular file: ${relative}`);
    const to = path.resolve(targetDir, relative);
    if (!to.startsWith(`${path.resolve(targetDir)}${path.sep}`)) {
      throw new Error(`Refusing to write a package file outside the installation root: ${relative}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o640);
  }
  return targetDir;
}

/** Install a package into `<store>/<name>/<version>/`. Fails if that version exists. */
function installPackageFiles(name, version, sourceRoot, files) {
  ensureStoreRoot();
  const target = versionDir(name, version);
  if (fs.existsSync(target)) {
    throw new Error(`Module "${name}" version ${version} is already present in the managed store`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return materialize(sourceRoot, target, files);
}

/** Stage a candidate upgrade beside the live installation without touching it. */
function stagePackageFiles(name, sourceRoot, files) {
  ensureStoreRoot();
  const staging = path.join(moduleDir(name), `.staging-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  return materialize(sourceRoot, staging, files);
}

/** Promote a staged directory to its version directory. */
function promoteStaged(name, version, stagingDir) {
  if (!isManagedPath(stagingDir)) throw new Error("Refusing to promote a staging directory outside the managed store");
  const target = versionDir(name, version);
  if (fs.existsSync(target)) removeDirectory(target);
  fs.renameSync(stagingDir, target);
  return target;
}

/** Remove a directory, but only inside the managed store. */
function removeDirectory(directory) {
  if (!isManagedPath(directory)) {
    throw new Error(`Refusing to remove a path outside the managed module store: ${directory}`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Remove every installed version of a module. */
function removeModule(name) {
  const directory = moduleDir(name);
  if (!fs.existsSync(directory)) return { removed: false, path: directory };
  removeDirectory(directory);
  return { removed: true, path: directory };
}

function listInstalledVersions(name) {
  const directory = moduleDir(name);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort();
}

module.exports = {
  moduleStoreRoot,
  moduleDir,
  versionDir,
  isManagedPath,
  ensureStoreRoot,
  installPackageFiles,
  stagePackageFiles,
  promoteStaged,
  removeDirectory,
  removeModule,
  listInstalledVersions,
};
