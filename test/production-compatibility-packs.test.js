"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "test-data-production-compatibility-packs");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_SECRET_KEY = "production-compatibility-packs-test-key";

require("../src/db").runPendingMigrations();
const lifecycle = require("../src/packs/lifecycle");
const packs = [
  "linux-systems-administration",
  "observability-incident-response",
  "backup-restore-dr",
  "storage-filesystems",
  "network-services",
];

function test(name, fn) {
  try { fn(); console.log(`Passed: ${name}`); }
  catch (error) { console.error(`Failed: ${name}: ${error.stack}`); process.exitCode = 1; }
}

test("PCA.1: all five manifests inspect without placeholders or missing references", () => {
  for (const name of packs) {
    const result = lifecycle.inspect(path.join(__dirname, "..", "packs", name));
    assert.equal(result.installable, true, `${name}: ${result.problems.join("; ")}`);
    assert.deepEqual(result.problems, []);
    assert.equal(result.modules.length, 1);
    assert.ok(result.workflows.length >= 1, `${name}: at least one workflow is required`);
    assert.equal(result.knowledge.length, 2);
    assert.deepEqual(result.requires.missing, []);
  }
});

test("PCA.2: malformed adapter input is rejected by the descriptor schemas", () => {
  const entry = require("../packs/network-services/modules/network-services-tools/entry");
  const descriptor = entry.buildDescriptors({ config: {}, dispatch: async () => ({}) })
    .find(item => item.name === "network_connectivity_review");
  assert.equal(descriptor.schema.safeParse({ source: "a", destination: "b", protocol: "tcp", port: 70000 }).success, false);
  assert.equal(descriptor.schema.safeParse({ source: "a", destination: "b", protocol: "tcp", port: 443 }).success, true);
});

test("PCA.2b: paths, identifiers, and action minimums are bounded", () => {
  const backup = require("../packs/backup-restore-dr/modules/backup-restore-tools/entry").buildDescriptors({ config: {}, dispatch: async () => ({}) });
  assert.equal(backup.find(item => item.name === "backup_database").schema.safeParse({ path: "../backup.db" }).success, false);
  const observability = require("../packs/observability-incident-response/modules/observability-incident-tools/entry").buildDescriptors({ config: { default_profile: "standard" }, dispatch: async () => ({}) });
  assert.equal(observability.find(item => item.name === "observability_metrics_query").schema.safeParse({ action: "write", measurement: "bad/name", fields: {} }).success, false);
  const nginx = require("../packs/network-services/modules/network-services-tools/entry").buildDescriptors({ config: {}, dispatch: async () => ({}) }).find(item => item.name === "network_nginx_operation");
  assert.equal(nginx.schema.safeParse({ action: "add_site", domain: "example.test" }).success, false);
});

test("PCA.3: unavailable delegated providers remain visible", async () => {
  const calls = [];
  const services = {
    config: { default_services: "svc" },
    dispatch: (tool, args) => {
      calls.push([tool, args]);
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code: "provider_unavailable" }) }] };
    },
  };
  const entry = require("../packs/linux-systems-administration/modules/linux-systems-tools/entry");
  const descriptor = entry.buildDescriptors(services).find(item => item.name === "linux_service_operation");
  const result = await descriptor.handler({ action: "status", service: "missing.service" });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, [["service", { action: "status", service: "missing.service" }]]);
});

(async () => {
  const unavailableCalls = [];
  const unavailable = { config: { default_profile: "standard" }, dispatch: async (name) => { unavailableCalls.push(name); throw Object.assign(new Error("not configured"), { code: "not_configured" }); } };
  const network = require("../packs/network-services/modules/network-services-tools/entry").buildDescriptors(unavailable).find(item => item.name === "network_service_audit");
  const networkResult = JSON.parse((await network.handler({})).content[0].text);
  assert.equal(networkResult.network.state, "unavailable");
  assert.deepEqual(unavailableCalls, ["network", "dhcp", "vpn", "nginx"]);
  const linux = require("../packs/linux-systems-administration/modules/linux-systems-tools/entry").buildDescriptors({ config: {}, dispatch: async () => ({}) }).find(item => item.name === "linux_service_operation");
  assert.equal((await linux.handler({ action: "status", service: "../../etc" })).code, "invalid_input");
  const backup = require("../packs/backup-restore-dr/modules/backup-restore-tools/entry").buildDescriptors({ config: {}, dispatch: async () => ({}) }).find(item => item.name === "backup_database");
  assert.equal((await backup.handler({ path: "../outside.db" })).code, "invalid_path");
  for (const name of packs) {
    const result = lifecycle.install(path.join(__dirname, "..", "packs", name), { enable: true });
    assert.equal(result.pack.state, "enabled", `${name} should enable through the normal lifecycle`);
    assert.equal(lifecycle.health(name).status, "healthy", `${name} should report healthy module preconditions`);
    lifecycle.disable(name);
    assert.equal(lifecycle.health(name).status, "disabled", `${name} should report disabled after disable`);
    lifecycle.uninstall(name);
  }
  if (!process.exitCode) console.log("All production compatibility pack tests passed.");
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch(error => {
  console.error(error.stack || error);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
});
