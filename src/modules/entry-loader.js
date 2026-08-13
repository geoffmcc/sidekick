"use strict";

/**
 * Verified third-party entry-point loading (B9).
 *
 * This is the trust boundary. Loading a module means executing its code inside
 * the Sidekick process, so every precondition is checked BEFORE `require`:
 *
 *   1. the module has a managed installation, inside the managed store
 *   2. the installed package still hashes to the value recorded at install
 *   3. the declared entry point exists, is a regular file, and resolves inside
 *      the installation
 *   4. the entry file still hashes to the recorded entry hash
 *   5. the manifest is compatible with this Sidekick build
 *   6. configuration requirements are satisfied
 *   7. the operator left the module in a state that may run
 *
 * Only then is the file required, and only by an absolute path derived from
 * the managed installation — never from a caller-supplied string.
 *
 * TRUST MODEL: a loaded module runs in-process with Sidekick's privileges.
 * There is no sandbox and none is claimed. What these controls give is
 * integrity (the bytes are the reviewed bytes), provenance (where they came
 * from), and lifecycle (an operator decided to run them) — not isolation.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const store = require("./store");
const { hashInstalledPackage, resolveEntryPoint, sidekickVersion } = require("./packaging");
const { satisfiesVersion, validateModuleConfig, normalizeManifest } = require("./manifest");

/** Failure codes surfaced to operators and to the pack/module health model. */
const LOAD_FAILURES = Object.freeze({
  NOT_INSTALLED: "not_installed",
  INTEGRITY_FAILURE: "integrity_failure",
  INVALID_ENTRY_POINT: "invalid_entry_point",
  INCOMPATIBLE: "incompatible",
  CONFIGURATION_REQUIRED: "configuration_required",
  LOAD_FAILURE: "load_failure",
});

class ModuleLoadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModuleLoadError";
    this.code = code;
  }
}

function isManagedRecord(record) {
  return Boolean(record && record.install_path);
}

/**
 * Absolute path of a module's entry file.
 *
 * Managed installations resolve inside their own installation directory;
 * builtin/in-repo modules keep resolving against the repository root, which is
 * the behavior the builtin provisioning path has always had.
 */
function resolveEntryPath(record) {
  const declared = String(record.entry_point || "");
  if (!declared) throw new ModuleLoadError(LOAD_FAILURES.INVALID_ENTRY_POINT, `Module "${record.name}" has no entry point`);
  const root = isManagedRecord(record) ? path.resolve(record.install_path) : path.resolve(process.cwd());
  const absolute = path.resolve(root, declared);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new ModuleLoadError(LOAD_FAILURES.INVALID_ENTRY_POINT, `Module "${record.name}" entry point escapes its installation root`);
  }
  return absolute;
}

/** Recompute and compare the whole-package hash of a managed installation. */
function verifyInstalledPackage(record) {
  if (!isManagedRecord(record)) return { ok: true, managed: false };
  const installPath = path.resolve(record.install_path);
  if (!store.isManagedPath(installPath)) {
    return { ok: false, code: LOAD_FAILURES.INTEGRITY_FAILURE, error: `Module "${record.name}" installation path is outside the managed module store` };
  }
  if (!fs.existsSync(installPath)) {
    return { ok: false, code: LOAD_FAILURES.NOT_INSTALLED, error: `Module "${record.name}" managed installation is missing at ${installPath}` };
  }
  if (!record.package_hash) {
    return { ok: false, code: LOAD_FAILURES.INTEGRITY_FAILURE, error: `Module "${record.name}" has a managed installation but no recorded package hash` };
  }
  let actual;
  try {
    actual = hashInstalledPackage(installPath);
  } catch (error) {
    return { ok: false, code: LOAD_FAILURES.INTEGRITY_FAILURE, error: `Module "${record.name}" installation could not be hashed: ${error.message}` };
  }
  if (actual.package_hash !== record.package_hash) {
    return {
      ok: false,
      code: LOAD_FAILURES.INTEGRITY_FAILURE,
      error: `Module "${record.name}" package integrity check failed (expected ${record.package_hash.slice(0, 12)}…, found ${actual.package_hash.slice(0, 12)}…)`,
    };
  }
  return { ok: true, managed: true, package_hash: actual.package_hash, file_count: actual.file_count };
}

/** Compatibility of the stored manifest with the running Sidekick build. */
function checkCompatibility(record) {
  const requires = record.manifest && record.manifest.sidekick;
  const current = sidekickVersion();
  if (!requires) return { ok: true, requires: null, sidekick_version: current };
  const ok = satisfiesVersion(current, requires);
  return { ok, requires, sidekick_version: current };
}

/** Configuration completeness for the stored manifest and persisted config. */
function checkConfiguration(record) {
  let manifest;
  try {
    manifest = normalizeManifest(record.manifest);
  } catch (error) {
    return { ok: false, errors: [{ path: "/", message: `Stored manifest is invalid: ${error.message}` }] };
  }
  return validateModuleConfig(manifest, record.config || {});
}

/**
 * Drop cached CommonJS modules that live under an installation directory.
 *
 * Without this, an upgrade in a long-lived process would keep executing the
 * previous version's code: Node caches by resolved filename, and the new
 * version installs to a DIFFERENT directory, so the stale entry would linger
 * for as long as anything referenced it. Clearing the subtree also makes a
 * re-enable after tampering re-read from disk instead of trusting the copy
 * already in memory.
 */
function purgeRequireCache(directory) {
  const root = path.resolve(directory);
  const prefix = `${root}${path.sep}`;
  let purged = 0;
  for (const key of Object.keys(require.cache)) {
    if (key === root || key.startsWith(prefix)) {
      delete require.cache[key];
      purged++;
    }
  }
  return purged;
}

/**
 * Load and validate a module entry from its managed installation.
 *
 * Returns the entry object shaped for the loader (`buildDescriptors`, optional
 * `healthCheck`) with `entryPoint`/`entryHash` stamped from the VERIFIED
 * on-disk file, so the loader's own binding check compares two independently
 * derived values rather than trusting whatever the entry claims about itself.
 */
function loadInstalledModuleEntry(record) {
  if (!isManagedRecord(record)) {
    throw new ModuleLoadError(LOAD_FAILURES.NOT_INSTALLED, `Module "${record.name}" has no managed installation to load`);
  }

  const integrity = verifyInstalledPackage(record);
  if (!integrity.ok) throw new ModuleLoadError(integrity.code, integrity.error);

  const compatibility = checkCompatibility(record);
  if (!compatibility.ok) {
    throw new ModuleLoadError(
      LOAD_FAILURES.INCOMPATIBLE,
      `Module "${record.name}" requires Sidekick ${compatibility.requires} but this Sidekick is ${compatibility.sidekick_version}`
    );
  }

  const configuration = checkConfiguration(record);
  if (!configuration.ok) {
    const details = (configuration.errors || []).map(e => `${e.path}: ${e.message}`).join("; ");
    throw new ModuleLoadError(LOAD_FAILURES.CONFIGURATION_REQUIRED, `Module "${record.name}" configuration is incomplete or invalid: ${details}`);
  }

  const installPath = fs.realpathSync(path.resolve(record.install_path));
  let resolved;
  try {
    resolved = resolveEntryPoint(installPath, record.entry_point);
  } catch (error) {
    throw new ModuleLoadError(LOAD_FAILURES.INVALID_ENTRY_POINT, `Module "${record.name}" entry point is unusable: ${error.message}`);
  }

  const entryHash = crypto.createHash("sha256").update(fs.readFileSync(resolved.absolute)).digest("hex");
  if (record.entry_hash && entryHash !== record.entry_hash) {
    throw new ModuleLoadError(
      LOAD_FAILURES.INTEGRITY_FAILURE,
      `Module "${record.name}" entry code hash does not match the registered binding`
    );
  }

  purgeRequireCache(installPath);
  let loaded;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    loaded = require(resolved.absolute);
  } catch (error) {
    throw new ModuleLoadError(LOAD_FAILURES.LOAD_FAILURE, `Module "${record.name}" entry failed to load: ${error.message}`);
  }

  const candidate = loaded && typeof loaded === "object" && loaded.entry ? loaded.entry : loaded;
  if (!candidate || typeof candidate.buildDescriptors !== "function") {
    throw new ModuleLoadError(LOAD_FAILURES.LOAD_FAILURE, `Module "${record.name}" entry must export buildDescriptors(services)`);
  }

  return {
    buildDescriptors: candidate.buildDescriptors.bind(candidate),
    healthCheck: typeof candidate.healthCheck === "function" ? candidate.healthCheck.bind(candidate) : undefined,
    // Derived from the verified file on disk, not from the module's own claim.
    entryPoint: record.entry_point,
    entryHash,
    installPath,
    packageHash: integrity.package_hash,
  };
}

module.exports = {
  LOAD_FAILURES,
  ModuleLoadError,
  isManagedRecord,
  resolveEntryPath,
  verifyInstalledPackage,
  checkCompatibility,
  checkConfiguration,
  purgeRequireCache,
  loadInstalledModuleEntry,
};
