"use strict";

/**
 * Managed capability-pack store.
 *
 * Mirrors the module store's contract for the same reasons: the pack that runs
 * is a Sidekick-owned copy, not the operator's source directory, so the
 * recorded package hash keeps meaning something after install.
 *
 *   <SIDEKICK_DATA_DIR>/packs/<pack-name>/<version>/
 *   <SIDEKICK_DATA_DIR>/packs/<pack-name>/.staging-<random>/
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PACK_NAME_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_DIR_RE = /^[0-9A-Za-z.\-+]+$/;

function dataDir() {
  return process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");
}

function packStoreRoot() {
  return path.resolve(dataDir(), "packs");
}

function assertSafeName(name) {
  if (!PACK_NAME_RE.test(String(name || ""))) throw new Error(`Invalid pack name for the managed store: ${name}`);
  return String(name);
}

function assertSafeVersion(version) {
  const value = String(version || "");
  if (!VERSION_DIR_RE.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid pack version for the managed store: ${version}`);
  }
  return value;
}

function packDir(name) {
  return path.join(packStoreRoot(), assertSafeName(name));
}

function versionDir(name, version) {
  return path.join(packDir(name), assertSafeVersion(version));
}

function isManagedPath(candidate) {
  if (!candidate) return false;
  const relative = path.relative(packStoreRoot(), path.resolve(String(candidate)));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function materialize(sourceRoot, targetDir, files) {
  const resolvedSource = fs.realpathSync(path.resolve(sourceRoot));
  fs.mkdirSync(targetDir, { recursive: true });
  for (const relative of files) {
    const from = path.resolve(resolvedSource, relative);
    if (!from.startsWith(`${resolvedSource}${path.sep}`)) throw new Error(`Refusing to copy a pack file outside the pack root: ${relative}`);
    if (!fs.lstatSync(from).isFile()) throw new Error(`Pack file is not a regular file: ${relative}`);
    const to = path.resolve(targetDir, relative);
    if (!to.startsWith(`${path.resolve(targetDir)}${path.sep}`)) throw new Error(`Refusing to write a pack file outside the installation root: ${relative}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o640);
  }
  return targetDir;
}

function installPackFiles(name, version, sourceRoot, files) {
  fs.mkdirSync(packStoreRoot(), { recursive: true });
  const target = versionDir(name, version);
  if (fs.existsSync(target)) throw new Error(`Capability pack "${name}" version ${version} is already present in the managed store`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return materialize(sourceRoot, target, files);
}

function stagePackFiles(name, sourceRoot, files) {
  fs.mkdirSync(packStoreRoot(), { recursive: true });
  const staging = path.join(packDir(name), `.staging-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  return materialize(sourceRoot, staging, files);
}

/**
 * Remove abandoned upgrade staging directories after a process crash.
 *
 * Staging directories are never active installations: promotion is one rename
 * into the version directory.  Only the narrowly named `.staging-*` children
 * of this pack are eligible, so recovery cannot sweep a version or an
 * operator-created directory.  The caller should run this before starting a
 * new install/upgrade attempt and may expose the result in diagnostics.
 */
function recoverStaging(name) {
  const directory = packDir(name);
  if (!fs.existsSync(directory)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(".staging-") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const candidate = path.join(directory, entry.name);
    removeDirectory(candidate);
    removed.push(candidate);
  }
  return removed;
}

function promoteStaged(name, version, stagingDir) {
  if (!isManagedPath(stagingDir)) throw new Error("Refusing to promote a staging directory outside the managed pack store");
  const target = versionDir(name, version);
  if (fs.existsSync(target)) removeDirectory(target);
  fs.renameSync(stagingDir, target);
  return target;
}

function removeDirectory(directory) {
  if (!isManagedPath(directory)) throw new Error(`Refusing to remove a path outside the managed pack store: ${directory}`);
  fs.rmSync(directory, { recursive: true, force: true });
}

function removePack(name) {
  const directory = packDir(name);
  if (!fs.existsSync(directory)) return { removed: false, path: directory };
  removeDirectory(directory);
  return { removed: true, path: directory };
}

module.exports = {
  packStoreRoot,
  packDir,
  versionDir,
  isManagedPath,
  installPackFiles,
  stagePackFiles,
  recoverStaging,
  promoteStaged,
  removeDirectory,
  removePack,
};
