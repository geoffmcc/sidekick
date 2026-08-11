"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const repository = require("./repository");

function relativeEntryPoint(entryPath) {
  const root = path.resolve(process.cwd());
  const absolute = path.resolve(entryPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Module entry point must be inside the Sidekick repository root");
  }
  return relative.split(path.sep).join("/");
}

/** Validate and persist a discovered candidate without loading or executing it. */
function installDiscoveredModule(candidate, { entryPoint = "entry.js", config } = {}) {
  if (!candidate || !candidate.manifest || !candidate.module_root) throw new Error("A discovered module candidate is required");
  const moduleRoot = fs.realpathSync(path.resolve(candidate.module_root));
  const absoluteEntry = path.resolve(moduleRoot, entryPoint);
  if (!absoluteEntry.startsWith(`${moduleRoot}${path.sep}`) || !fs.existsSync(absoluteEntry)) {
    throw new Error(`Module entry point not found inside candidate: ${entryPoint}`);
  }
  const stat = fs.lstatSync(absoluteEntry);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Module entry point must be a regular file: ${entryPoint}`);
  const normalizedEntryPoint = relativeEntryPoint(absoluteEntry);
  const entryHash = crypto.createHash("sha256").update(fs.readFileSync(absoluteEntry)).digest("hex");
  return repository.registerModule(candidate.manifest, {
    source: "discovered",
    entryPoint: normalizedEntryPoint,
    entryHash,
    config,
  });
}

module.exports = { installDiscoveredModule };
