"use strict";
const assert = require("assert"),
  fs = require("fs"),
  path = require("path");
const { test } = require("node:test");
const data = fs.mkdtempSync(path.join(__dirname, ".jellyfin-lifecycle-"));
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
const moduleRepository = require("../src/modules/repository");
const moduleLoader = require("../src/modules/loader");
test("Jellyfin pack lifecycle", async (t) => {
  t.after(() => {
    require("../src/db").closeDatabase();
    fs.rmSync(data, { recursive: true, force: true });
  });
  await t.test("Jellyfin pack is authoritative-lifecycle installable", () => {
    const x = bundled.getBundledPack("jellyfin");
    assert.ok(x);
    const inspected = lifecycle.inspect(x.path, { sourceKind: "bundled" });
    assert.strictEqual(inspected.installable, true);
  });
  await t.test("install, enable, health, disable and uninstall", () => {
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
  await t.test("startup repair refreshes legacy module provenance from an exact bundled digest", () => {
    bundled.installBundledPack("jellyfin", { config: { profiles: {} }, enable: true });
    require("../src/db").getDb().prepare("UPDATE platform_modules SET provenance_json = '{}' WHERE name = ?").run("jellyfin-tools");
    const result = bundled.reconcileBundledPackModules();
    assert.deepStrictEqual(result.repaired, [{ name: "jellyfin", modules: ["jellyfin-tools"] }]);
    assert.deepStrictEqual(result.failed, []);
    assert.strictEqual(moduleRepository.getModule("jellyfin-tools").provenance.pack_provenance, "first_party");
    assert.strictEqual(repository.getPack("jellyfin").state, "enabled");
    assert.strictEqual(moduleLoader.isModuleActive("jellyfin-tools"), true);
    assert.deepStrictEqual(bundled.reconcileBundledPackModules().repaired, [], "repair is idempotent");
    lifecycle.uninstall("jellyfin");
  });
  await t.test("startup repair does not promote a third-party pack based on its name", () => {
    const candidate = bundled.getBundledPack("jellyfin");
    lifecycle.install(candidate.path, { provenance: "third_party", source: { kind: "bundled" }, config: { profiles: {} } });
    const result = bundled.reconcileBundledPackModules();
    assert.ok(result.skipped.some(item => item.name === "jellyfin" && item.reason === "pack_not_attested_first_party"));
    assert.strictEqual(repository.getPack("jellyfin").provenance, "third_party");
    assert.strictEqual(moduleLoader.isModuleActive("jellyfin-tools"), false);
    lifecycle.uninstall("jellyfin");
  });
});
