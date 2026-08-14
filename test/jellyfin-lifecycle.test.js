"use strict";
const assert = require("assert"),
  fs = require("fs"),
  path = require("path");
const data = path.join(__dirname, "test-data-jellyfin-lifecycle");
fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
process.env.SIDEKICK_DATA_DIR = data;
process.env.SIDEKICK_DB_FILE = path.join(data, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "jellyfin-lifecycle-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
require("../src/db").runPendingMigrations();
const bundled = require("../src/packs/bundled"),
  lifecycle = require("../src/packs/lifecycle"),
  repository = require("../src/packs/repository");
let failures = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`Passed: ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAILED: ${name}\n${e.stack}`);
  }
}
(async () => {
  await t("Jellyfin pack is authoritative-lifecycle installable", () => {
    const x = bundled.getBundledPack("jellyfin");
    assert.ok(x);
    const inspected = lifecycle.inspect(x.path, { sourceKind: "bundled" });
    assert.strictEqual(inspected.installable, true);
  });
  await t("install, enable, health, disable and uninstall", () => {
    const x = bundled.getBundledPack("jellyfin");
    lifecycle.install(x.path, {
      provenance: "first_party",
      source: { kind: "bundled", path: x.path },
      config: { profiles: {} },
      enable: false,
    });
    assert.strictEqual(repository.getPack("jellyfin").state, "installed");
    lifecycle.enable("jellyfin");
    const h = lifecycle.health("jellyfin");
    assert.ok(["healthy", "degraded"].includes(h.status));
    lifecycle.disable("jellyfin");
    lifecycle.uninstall("jellyfin");
    assert.strictEqual(repository.getPack("jellyfin"), null);
  });
  fs.rmSync(data, { recursive: true, force: true });
  if (failures) process.exitCode = 1;
  else console.log("All Jellyfin lifecycle tests passed.");
})();
