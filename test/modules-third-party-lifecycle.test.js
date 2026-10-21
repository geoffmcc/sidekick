"use strict";

// Third-party module management remains available, but executable activation
// is fail-closed until an OS-enforced backend and broker exist.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-unisolated-module-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const lifecycle = require("../src/modules/lifecycle");
const repository = require("../src/modules/repository");
const loader = require("../src/modules/loader");
const entries = require("../src/modules/entries");
const entryLoader = require("../src/modules/entry-loader");
const fixture = path.join(__dirname, "fixtures", "third-party-module", "v1");
const name = "synthetic-metrics";

test("untrusted package inspection, installation, and configuration do not execute entry code", () => {
  const inspection = lifecycle.inspect(fixture);
  assert.equal(inspection.installable, true);
  const installed = lifecycle.install(fixture);
  assert.equal(installed.module.source, "installed");
  assert.equal(installed.module.state, "installed");
  const configured = lifecycle.configure(name, { label: "synthetic" });
  assert.equal(configured.module.state, "configured");
  const entryPath = path.join(configured.module.install_path, "entry.js");
  assert.equal(require.cache[require.resolve(entryPath)], undefined);
});

test("both module entry loading and direct loader activation fail before untrusted code runs", () => {
  const record = repository.getModule(name);
  assert.throws(
    () => entryLoader.loadInstalledModuleEntry(record),
    error => error.code === entryLoader.LOAD_FAILURES.ISOLATION_UNAVAILABLE
  );

  let descriptorBuilderCalled = false;
  assert.throws(
    () => loader.enableModule(name, { buildDescriptors() { descriptorBuilderCalled = true; return []; } }),
    error => error.code === entryLoader.LOAD_FAILURES.ISOLATION_UNAVAILABLE
  );
  assert.equal(descriptorBuilderCalled, false, "direct entry injection cannot bypass the isolation boundary");
  assert.equal(loader.isModuleActive(name), false);
  assert.equal(repository.getModule(name).state, "configured", "an unavailable backend is not persisted as a module fault");
  assert.throws(
    () => lifecycle.enable(name),
    error => error.code === entryLoader.LOAD_FAILURES.ISOLATION_UNAVAILABLE
  );
});

test("upgrade of an untrusted module is denied before changing its registration or installed files", () => {
  const before = repository.getModule(name);
  const previousPath = before.install_path;
  const v2 = path.join(__dirname, "fixtures", "third-party-module", "v2");
  assert.throws(
    () => lifecycle.upgrade(name, v2),
    error => error.code === entryLoader.LOAD_FAILURES.ISOLATION_UNAVAILABLE
  );
  const after = repository.getModule(name);
  assert.equal(after.version, before.version);
  assert.equal(after.install_path, previousPath);
  assert.equal(fs.existsSync(previousPath), true);
  assert.equal(fs.existsSync(require("../src/modules/store").versionDir(name, "2.0.0")), false);
});

test("persisted enabled third-party modules remain inactive during recovery and report isolation unavailable", () => {
  repository.transitionModule(name, "enabled");
  const restored = entries.moduleEntriesByName();
  assert.equal(restored.entries[name], undefined);
  assert.equal(restored.failures.find(failure => failure.name === name)?.code, entryLoader.LOAD_FAILURES.ISOLATION_UNAVAILABLE);
  const result = loader.restorePersistedModules(restored.entries);
  assert.equal(result.restored.includes(name), false);
  assert.equal(loader.isModuleActive(name), false);
  const health = lifecycle.health(name, { runCheck: false });
  assert.equal(health.status, lifecycle.HEALTH_STATUS.ISOLATION_UNAVAILABLE);
  assert.deepEqual(health.isolation, { enforced: false, boundary: "none", status: "unavailable", mechanism: null });
});

test("first-party provenance cannot be self-asserted by a managed third-party module", () => {
  const record = repository.getModule(name);
  record.source = "pack";
  record.provenance = { source_kind: "capability_pack", pack: "fake", pack_version: "1.0.0", pack_package_hash: "0".repeat(64) };
  assert.throws(
    () => entryLoader.assertExecutionIsolation(record),
    error => error.code === entryLoader.LOAD_FAILURES.ISOLATION_UNAVAILABLE
  );
});

test.after(() => {
  try { require("../src/db").closeDatabase(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});
