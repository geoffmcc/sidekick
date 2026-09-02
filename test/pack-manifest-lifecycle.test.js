"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-pack-manifests-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

require("../src/db").runPendingMigrations();
const lifecycle = require("../src/packs/lifecycle");

const packs = [
  "api-engineering",
  "database-administration",
  "ci-cd-release-engineering",
  "infrastructure-as-code",
  "testing-quality-engineering",
  "container-operations",
  "network-firewall",
];
const root = path.join(__dirname, "..");

try {
  for (const name of packs) {
    const source = path.join(root, "packs", name);
    const inspection = lifecycle.inspect(source, { hasTool: () => true });
    assert.strictEqual(inspection.installable, true, `${name}: ${inspection.problems.join("; ")}`);
    const permissionKey = permission => `${permission.tool || "capability"}:${permission.tool ? permission.risk : permission.capability}`;
    assert.deepStrictEqual(
      inspection.permissions.declared.map(permissionKey).sort(),
      inspection.permissions.derived.map(permissionKey).sort(),
      `${name} permissions should match its module`
    );
  }

  for (const name of ["container-operations", "network-firewall"]) {
    const installed = lifecycle.install(path.join(root, "packs", name), { enable: false });
    assert.strictEqual(installed.pack.state, "installed", `${name} should install through lifecycle`);
    assert.strictEqual(lifecycle.health(name).components.find(component => component.component === "permissions").ok, true, `${name} permissions should be consistent`);
    lifecycle.uninstall(name);
  }
  console.log("Pack manifest lifecycle tests passed.");
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
