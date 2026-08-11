"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MANIFEST_FILENAMES } = require("./discovery");
const { parseManifestFile } = require("./manifest");

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const SENSITIVE_FILE_RE = /(^|\/)(?:\.env(?:\..*)?|.*\.pem|.*\.key|.*\.p12|credentials\.json|secrets?\.json)$/i;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function collectFiles(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Module package contains a symlink: ${path.relative(root, fullPath)}`);
    if (entry.isDirectory()) collectFiles(root, fullPath, files);
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

/** Build a deterministic, non-archiving package manifest for review/signing. */
function inspectModulePackage(moduleRoot) {
  const root = fs.realpathSync(path.resolve(moduleRoot));
  const manifestName = MANIFEST_FILENAMES.find(name => fs.existsSync(path.join(root, name)));
  if (!manifestName) throw new Error(`Module package has no manifest (${MANIFEST_FILENAMES.join(" or ")})`);
  const manifest = parseManifestFile(path.join(root, manifestName));
  const files = collectFiles(root).sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
  const entries = files.map(filePath => {
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    if (SENSITIVE_FILE_RE.test(relativePath)) throw new Error(`Module package contains a sensitive file: ${relativePath}`);
    const content = fs.readFileSync(filePath);
    return { path: relativePath, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  });
  const packageHash = crypto.createHash("sha256").update(entries.map(entry => `${entry.path}\0${entry.sha256}\n`).join(""), "utf8").digest("hex");
  return Object.freeze({ format: "sidekick-module-package-v1", name: manifest.name, version: manifest.version, manifest_file: manifestName, files: entries, package_hash: packageHash });
}

module.exports = { inspectModulePackage };
