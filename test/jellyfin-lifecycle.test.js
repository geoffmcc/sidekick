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
});
