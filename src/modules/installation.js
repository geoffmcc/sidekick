"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const repository = require("./repository");
const store = require("./store");
const { inspectPackageForInstall } = require("./packaging");

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

/**
 * Install a third-party module package into the managed store (B9).
 *
 * The directory the operator points at is a SOURCE, never the runtime
 * installation. The sequence is deliberate:
 *
 *   1. inspect the package without executing any of it;
 *   2. refuse it outright if inspection found anything disqualifying
 *      (traversal, symlink, bad entry point, incompatible, collision, secret
 *      file, duplicate identity);
 *   3. copy exactly the inspected files into <store>/<name>/<version>/;
 *   4. re-hash the managed copy and require it to equal the inspected hash —
 *      this catches a source tree that changed underneath the copy;
 *   5. persist identity, provenance, package hash and entry binding.
 *
 * Nothing is loaded here. Registration ends in `validated`; installation,
 * configuration and enablement are separate explicit lifecycle steps.
 */
function installModulePackage(sourcePath, { config, provenance = {}, source = "installed", entryPoint } = {}) {
  const inspection = inspectPackageForInstall(sourcePath, { entryPoint });
  if (!inspection.installable) {
    throw new Error(`Module package cannot be installed: ${inspection.problems.join("; ")}`);
  }

  const installPath = store.installPackageFiles(
    inspection.name,
    inspection.version,
    inspection.source.path,
    inspection.files.map(file => file.path)
  );

  let record;
  try {
    const { hashInstalledPackage } = require("./packaging");
    const verified = hashInstalledPackage(installPath);
    if (verified.package_hash !== inspection.package_hash) {
      throw new Error("managed installation hash does not match the inspected package (source changed during install)");
    }
    const entryAbsolute = path.resolve(installPath, inspection.entry_point);
    const entryHash = crypto.createHash("sha256").update(fs.readFileSync(entryAbsolute)).digest("hex");
    record = repository.registerModule(inspection.manifest, {
      source,
      entryPoint: inspection.entry_point,
      entryHash,
      installPath,
      packageHash: verified.package_hash,
      provenance: {
        source_kind: inspection.source.kind,
        source_path: inspection.source.path,
        installed_at: new Date().toISOString(),
        sidekick_version: inspection.compatibility.sidekick_version,
        ...provenance,
      },
      config,
    });
  } catch (error) {
    // Never leave an orphaned managed installation behind a failed register.
    try { store.removeDirectory(installPath); } catch {}
    throw error;
  }

  return { module: record, inspection, install_path: installPath };
}

module.exports = { installDiscoveredModule, installModulePackage };
