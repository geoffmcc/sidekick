"use strict";

const fs = require("fs");
const path = require("path");
const { parseManifestFile } = require("./manifest");

const MANIFEST_FILENAMES = Object.freeze(["manifest.json", "sidekick.module.json"]);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function candidateDirectories(root, directories) {
  const result = [];
  for (const name of directories) {
    const directory = path.resolve(root, name);
    if (!isWithin(root, directory)) continue;
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const moduleRoot = path.join(directory, entry.name);
      if (isWithin(root, moduleRoot)) result.push(moduleRoot);
    }
  }
  return result;
}

/**
 * Discover manifest candidates without registering or activating anything.
 * Discovery is deterministic, bounded to the supplied module/plugin roots,
 * rejects symlinked module directories, and reports every invalid candidate
 * instead of allowing one malformed module to hide the rest.
 */
function discoverModules(root = process.cwd(), { directories = ["modules", "plugins"] } = {}) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const candidates = [];
  const errors = [];
  const names = new Map();

  for (const moduleRoot of candidateDirectories(resolvedRoot, directories)) {
    const manifestName = MANIFEST_FILENAMES.find(name => fs.existsSync(path.join(moduleRoot, name)));
    if (!manifestName) continue;
    const manifestPath = path.join(moduleRoot, manifestName);
    try {
      const realManifestPath = fs.realpathSync(manifestPath);
      if (!isWithin(resolvedRoot, realManifestPath)) throw new Error("manifest resolves outside the discovery root");
      const manifest = parseManifestFile(realManifestPath);
      if (names.has(manifest.name)) {
        throw new Error(`duplicate module name; first declared at ${names.get(manifest.name)}`);
      }
      names.set(manifest.name, realManifestPath);
      candidates.push(Object.freeze({
        manifest,
        manifest_path: realManifestPath,
        module_root: moduleRoot,
        source: "discovered",
      }));
    } catch (error) {
      errors.push({ path: manifestPath, error: error.message });
    }
  }

  candidates.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  errors.sort((a, b) => a.path.localeCompare(b.path));
  return { root: resolvedRoot, candidates, errors };
}

module.exports = { MANIFEST_FILENAMES, discoverModules };
