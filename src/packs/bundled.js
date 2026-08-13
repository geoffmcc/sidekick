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

function bundledRoot() {
  return process.env.SIDEKICK_BUNDLED_PACKS_DIR || path.resolve(__dirname, "..", "..", "packs");
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
        upgrade_available: Boolean(installed) && installed.version !== manifest.version,
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
  });
}

/** Upgrade an installed pack from its bundled version (e.g. after a release). */
function upgradeBundledPack(name, options = {}) {
  const bundled = getBundledPack(name);
  if (!bundled) throw new Error(`No bundled capability pack named "${name}"`);
  return lifecycle.upgrade(name, bundled.path, options);
}

module.exports = { bundledRoot, listBundledPacks, getBundledPack, installBundledPack, upgradeBundledPack };
