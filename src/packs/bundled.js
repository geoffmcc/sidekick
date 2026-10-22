"use strict";

/**
 * Bundled first-party capability packs.
 *
 * First-party packs ship inside the signed Sidekick repository under `packs/`.
 * They differ from third-party packs in TRUST — their provenance is
 * `first_party` and their source is the release itself — and in nothing else:
 * they are installed, enabled, configured, upgraded, health-checked and
 * uninstalled through exactly the same lifecycle, from exactly the same
 * managed store. That is deliberate; a first-party pack that took a shortcut
 * would stop exercising the platform it is supposed to prove.
 */

const fs = require("fs");
const path = require("path");
const { PACK_MANIFEST_FILENAME, parsePackManifestFile, checkPackCompatibility } = require("./manifest");
const repository = require("./repository");
const lifecycle = require("./lifecycle");
const { sidekickVersion } = require("../modules/packaging");
const { compareVersions } = require("../modules/manifest");

/** True when the bundled version is semver-newer than the installed one. */
function bundledVersionIsNewer(bundledVersion, installedVersion) {
  try {
    return compareVersions(bundledVersion, installedVersion) > 0;
  } catch {
    // Unparseable version on either side: fall back to inequality so the
    // operator still sees that the bundled copy differs.
    return bundledVersion !== installedVersion;
  }
}

function bundledRoot() {
  // First-party trust must not be configurable through an environment path:
  // otherwise a deployment setting could label arbitrary executable code as
  // bundled. Alternate roots must use the normal third-party install path.
  return path.resolve(__dirname, "..", "..", "packs");
}

/** Enumerate bundled packs on disk. Never throws for one bad directory. */
function listBundledPacks() {
  const root = bundledRoot();
  if (!fs.existsSync(root)) return [];
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const packRoot = path.join(root, entry.name);
    const manifestPath = path.join(packRoot, PACK_MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = parsePackManifestFile(manifestPath);
      const compatibility = checkPackCompatibility(manifest, sidekickVersion());
      const installed = repository.getPack(manifest.name);
      results.push({
        name: manifest.name,
        display_name: manifest.display_name,
        version: manifest.version,
        description: manifest.description,
        publisher: manifest.publisher,
        path: packRoot,
        bundled: true,
        provenance: "first_party",
        compatible: compatibility.ok,
        requires_sidekick: compatibility.requires,
        installed: Boolean(installed),
        installed_version: installed ? installed.version : null,
        upgrade_available: Boolean(installed) && bundledVersionIsNewer(manifest.version, installed.version),
        modules: manifest.modules.map(m => m.name),
        workflows: manifest.workflows.length,
        knowledge: manifest.knowledge.length,
      });
    } catch (error) {
      results.push({ name: entry.name, path: packRoot, bundled: true, error: error.message, installed: false, compatible: false });
    }
  }
  return results;
}

function getBundledPack(name) {
  return listBundledPacks().find(pack => pack.name === name) || null;
}

/** Install a bundled pack through the normal lifecycle. */
function installBundledPack(name, { config, enable = false } = {}) {
  const bundled = getBundledPack(name);
  if (!bundled) throw new Error(`No bundled capability pack named "${name}"`);
  if (bundled.error) throw new Error(`Bundled capability pack "${name}" is invalid: ${bundled.error}`);
  return lifecycle.install(bundled.path, {
    config,
    provenance: "first_party",
    source: { kind: "bundled", path: bundled.path, release: sidekickVersion() },
    enable,
    expectedPackageHash: lifecycle.inspect(bundled.path).package_hash,
  });
}

/** Upgrade an installed pack from its bundled version (e.g. after a release). */
function upgradeBundledPack(name, options = {}) {
  const bundled = getBundledPack(name);
  if (!bundled) throw new Error(`No bundled capability pack named "${name}"`);
  return lifecycle.upgrade(name, bundled.path, {
    ...options,
    expectedPackageHash: lifecycle.inspect(bundled.path).package_hash,
  });
}

/**
 * Repair legacy module provenance for bundled packs after a Sidekick upgrade.
 *
 * This is intentionally narrower than a general pack upgrade: the persisted
 * pack must already be marked first-party, and its version and package digest
 * must exactly match the copy shipped in this release. The normal upgrade
 * lifecycle then refreshes owned module bindings from those verified bytes,
 * preserving pack configuration and disabled state. Third-party packs,
 * locally modified packages, and version mismatches are never promoted.
 */
function reconcileBundledPackModules() {
  const repaired = [];
  const skipped = [];
  const failed = [];
  const modules = require("../modules/repository");

  for (const candidate of listBundledPacks()) {
    if (candidate.error || !candidate.compatible) continue;
    const record = repository.getPack(candidate.name);
    if (!record) continue;
    if (record.provenance !== "first_party") {
      skipped.push({ name: record.name, reason: "pack_not_attested_first_party" });
      continue;
    }
    if (record.version !== candidate.version) {
      skipped.push({ name: record.name, reason: "release_version_mismatch" });
      continue;
    }

    let inspection;
    try { inspection = lifecycle.inspect(candidate.path); }
    catch (error) { failed.push({ name: record.name, error: error.message }); continue; }
    if (!record.package_hash || record.package_hash !== inspection.package_hash) {
      skipped.push({ name: record.name, reason: "release_digest_mismatch" });
      continue;
    }

    const staleModules = (record.manifest.modules || []).filter(reference => {
      const module = modules.getModule(reference.name);
      const provenance = module?.provenance || {};
      return !module || provenance.source_kind !== "capability_pack" ||
        provenance.pack !== record.name || provenance.pack_version !== record.version ||
        provenance.pack_package_hash !== record.package_hash || provenance.pack_provenance !== "first_party";
    });
    if (!staleModules.length) continue;

    try {
      upgradeBundledPack(record.name, {
        allowSameVersion: true,
        expectedPackageHash: inspection.package_hash,
      });
      repaired.push({ name: record.name, modules: staleModules.map(module => module.name) });
    } catch (error) {
      failed.push({ name: record.name, error: error.message });
    }
  }
  return { repaired, skipped, failed };
}

module.exports = { bundledRoot, listBundledPacks, getBundledPack, installBundledPack, upgradeBundledPack, reconcileBundledPackModules };
