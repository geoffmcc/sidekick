"use strict";

// Canonical-path fixture: every bundled pack is installed and enabled through
// the real lifecycle, then discovered and inspected through the dispatcher.
// Provider-backed domain calls are intentionally not faked here; those remain
// separately labelled unavailable-provider or configured-integration tests.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-pack-catalog-e2e-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "pack-catalog-e2e-fixture-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

require("../src/db").runPendingMigrations();
const bundled = require("../src/packs/bundled");
const lifecycle = require("../src/packs/lifecycle");
const { callInternalTool } = require("../src/tools/dispatcher");

function json(result) {
  assert.ok(result && Array.isArray(result.content), "dispatcher result must be structured");
  const text = result.content[0]?.text || "";
  return JSON.parse(text);
}

(async () => {
  const candidates = bundled.listBundledPacks().filter(pack => !pack.error);
  assert.strictEqual(candidates.length, 27, "all bundled packs must be valid candidates");
  const pending = [...candidates].sort((a, b) => (a.name === "developer" ? -1 : b.name === "developer" ? 1 : a.name.localeCompare(b.name)));
  const installedNames = new Set();
  while (pending.length) {
    const deferred = [];
    for (const candidate of pending) {
      try {
        const installed = bundled.installBundledPack(candidate.name);
        assert.strictEqual(installed.pack.state, "installed", `${candidate.name}: install state`);
        const enabled = lifecycle.enable(candidate.name);
        assert.strictEqual(enabled.pack.state, "enabled", `${candidate.name}: enable state`);
        const health = lifecycle.health(candidate.name);
        assert.ok(health && typeof health.status === "string", `${candidate.name}: structured health`);
        installedNames.add(candidate.name);
      } catch (error) {
        if (/required dependency pack|required tool/.test(error.message)) deferred.push(candidate);
        else throw error;
      }
    }
    if (deferred.length === pending.length) throw new Error(`Unable to resolve bundled pack dependencies: ${deferred.map(pack => pack.name).join(", ")}`);
    pending.splice(0, pending.length, ...deferred);
  }

  const catalog = json(await callInternalTool("capability", { action: "catalog", kind: "pack", limit: 500 }));
  assert.strictEqual(catalog.ok, true);
  assert.strictEqual(catalog.total, installedNames.size);
  assert.deepStrictEqual(new Set(catalog.entries.map(entry => entry.name)), new Set(candidates.map(pack => pack.name)));
  for (const candidate of candidates) {
    const detail = json(await callInternalTool("capability", { action: "show", name: candidate.name }));
    assert.strictEqual(detail.ok, true, `${candidate.name}: canonical detail dispatch`);
    assert.strictEqual(detail.pack.name, candidate.name);
    assert.ok(detail.pack.maturity && detail.pack.maturity.level, `${candidate.name}: maturity projection`);
  }
  console.log(`Canonical pack catalog E2E fixture passed for ${candidates.length} packs`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true }), 0);
});
