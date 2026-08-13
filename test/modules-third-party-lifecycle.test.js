// B9: third-party module lifecycle, end to end, against synthetic fixtures.
//
// Proves the whole operator path — inspect, install, configure, enable, invoke
// the contributed tool through the real dispatcher, health, disable, re-enable,
// upgrade (with visibly changed behavior), uninstall — plus the two fail-closed
// properties that make third-party loading safe at all: mutation after install
// is detected before any code runs, and a package that shadows a built-in
// descriptor is refused.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-modules-third-party');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(TEST_DATA_DIR, 'sidekick.db');
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'modules-third-party-test-secret-key';

const lifecycle = require('../src/modules/lifecycle');
const repository = require('../src/modules/repository');
const loader = require('../src/modules/loader');
const store = require('../src/modules/store');
const entryLoader = require('../src/modules/entry-loader');
const { callInternalTool } = require('../src/tools/dispatcher');

const FIXTURES = path.join(__dirname, 'fixtures', 'third-party-module');
const V1 = path.join(FIXTURES, 'v1');
const V2 = path.join(FIXTURES, 'v2');
const COLLIDE = path.join(FIXTURES, 'collide');
const NAME = 'synthetic-metrics';

function toolJson(result) {
  return JSON.parse(result.content[0].text);
}

let failures = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`Passed: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAILED: ${label}\n  ${error && error.stack ? error.stack : error}`);
  }
}

(async () => {
  console.log('Running B9 third-party module lifecycle tests...\n');

  // --- B9.1 inspection is safe and complete -------------------------------
  let inspection;
  test('B9.1: inspect reports identity, entry point, hash, tools and config without executing code', () => {
    inspection = lifecycle.inspect(V1);
    assert.strictEqual(inspection.name, NAME);
    assert.strictEqual(inspection.version, '1.0.0');
    assert.strictEqual(inspection.display_name, 'Synthetic Metrics (fixture)');
    assert.strictEqual(inspection.entry_point, 'entry.js');
    assert.match(inspection.package_hash, /^[a-f0-9]{64}$/);
    assert.strictEqual(inspection.file_count, 2);
    assert.strictEqual(inspection.compatibility.compatible, true);
    assert.deepStrictEqual(inspection.tools.map(t => t.name), ['synthetic_metric']);
    assert.deepStrictEqual(inspection.configuration.required, ['label']);
    assert.strictEqual(inspection.configuration.required_before_enable, true);
    assert.strictEqual(inspection.installable, true);
    assert.strictEqual(inspection.source.path, fs.realpathSync(V1));
  });

  test('B9.2: inspection refuses a package whose entry point escapes the package root', () => {
    const bad = path.join(TEST_DATA_DIR, 'bad-entry');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({
      name: 'bad-entry', version: '1.0.0', description: 'traversal attempt', tools: {},
    }));
    fs.writeFileSync(path.join(bad, 'entry.js'), 'module.exports = {};\n');
    const result = lifecycle.inspect(bad, { entryPoint: '../../../etc/passwd' });
    assert.strictEqual(result.installable, false);
    assert.ok(result.problems.some(p => /traverse outside the package root/.test(p)), result.problems.join('; '));
  });

  test('B9.3: inspection refuses a package containing a sensitive file', () => {
    const bad = path.join(TEST_DATA_DIR, 'bad-secret');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({
      name: 'bad-secret', version: '1.0.0', description: 'packs a key', tools: {},
    }));
    fs.writeFileSync(path.join(bad, 'entry.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(bad, 'server.key'), 'not-a-real-key');
    assert.throws(() => lifecycle.inspect(bad), /sensitive file/);
  });

  // --- B9.4 install into the managed store ---------------------------------
  let installed;
  test('B9.4: install copies into the managed store and records identity, hash and provenance', () => {
    installed = lifecycle.install(V1, { provenance: { installed_by: 'b9-test' } });
    const record = repository.getModule(NAME);
    assert.strictEqual(record.state, 'installed', 'config is required, so install stops at installed');
    assert.strictEqual(record.version, '1.0.0');
    assert.strictEqual(record.source, 'installed');
    assert.strictEqual(record.package_hash, inspection.package_hash);
    assert.strictEqual(record.entry_point, 'entry.js');
    assert.match(record.entry_hash, /^[a-f0-9]{64}$/);
    assert.ok(store.isManagedPath(record.install_path), `install path must be managed: ${record.install_path}`);
    assert.strictEqual(record.install_path, store.versionDir(NAME, '1.0.0'));
    assert.strictEqual(record.provenance.source_path, fs.realpathSync(V1));
    assert.strictEqual(record.provenance.installed_by, 'b9-test');
    assert.ok(fs.existsSync(path.join(record.install_path, 'entry.js')));
    // The managed copy is what runs; it is not the operator's source tree.
    assert.notStrictEqual(record.install_path, fs.realpathSync(V1));
  });

  test('B9.5: enabling before configuration fails closed', () => {
    assert.throws(() => lifecycle.enable(NAME), /configuration is incomplete|cannot be enabled|required/i);
    assert.strictEqual(loader.isModuleActive(NAME), false);
  });

  test('B9.6: invalid configuration is rejected, valid configuration persists', () => {
    assert.throws(() => lifecycle.configure(NAME, { label: 'x', factor: 0 }), /config is invalid/);
    assert.throws(() => lifecycle.configure(NAME, { label: 'x', nope: true }), /config is invalid/);
    const result = lifecycle.configure(NAME, { label: 'alpha', factor: 3 });
    assert.strictEqual(result.module.state, 'configured');
    assert.deepStrictEqual(repository.getModule(NAME).config, { label: 'alpha', factor: 3 });
  });

  // --- B9.7 enable -> descriptor available -> real invocation --------------
  test('B9.7: enable loads the verified entry and registers the contributed descriptor', () => {
    const result = lifecycle.enable(NAME);
    assert.strictEqual(result.module.state, 'enabled');
    assert.strictEqual(result.entry_kind, 'managed');
    assert.deepStrictEqual(result.descriptors, ['synthetic_metric']);
    assert.ok(require('../src/tools').getBuiltinRegistry().has('synthetic_metric'));
    assert.ok(require('../src/tools').getBuiltinRegistry().has('synthetic_metrics'), 'alias resolves');
  });

  await (async () => {
    try {
      const result = await callInternalTool('synthetic_metric', { value: 5 });
      const payload = toolJson(result);
      assert.strictEqual(result.isError, undefined, JSON.stringify(result));
      assert.strictEqual(payload.api, 'v1');
      assert.strictEqual(payload.label, 'alpha');
      assert.strictEqual(payload.result, 15, 'handler receives the validated module configuration');
      console.log('Passed: B9.8: the contributed tool dispatches through the real dispatcher');
    } catch (error) {
      failures++;
      console.error(`FAILED: B9.8: the contributed tool dispatches through the real dispatcher\n  ${error.stack || error}`);
    }
  })();

  test('B9.9: health reports healthy with per-component evidence', () => {
    const health = lifecycle.health(NAME);
    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.managed, true);
    assert.strictEqual(health.active_in_process, true);
    const byComponent = Object.fromEntries(health.components.map(c => [c.component, c.ok]));
    assert.strictEqual(byComponent.package_integrity, true);
    assert.strictEqual(byComponent.compatibility, true);
    assert.strictEqual(byComponent.configuration, true);
    assert.strictEqual(byComponent.module_health_check, true);
  });

  // --- B9.10 disable / re-enable ------------------------------------------
  await (async () => {
    try {
      lifecycle.disable(NAME);
      assert.strictEqual(repository.getModule(NAME).state, 'disabled');
      assert.strictEqual(loader.isModuleActive(NAME), false);
      assert.strictEqual(require('../src/tools').getBuiltinRegistry().has('synthetic_metric'), false, 'no stale descriptor after disable');
      const denied = await callInternalTool('synthetic_metric', { value: 5 });
      assert.strictEqual(denied.isError, true);
      assert.ok(/Unknown tool/.test(denied.content[0].text), denied.content[0].text);
      assert.strictEqual(lifecycle.health(NAME).status, 'disabled');
      console.log('Passed: B9.10: disable removes the capability and reports disabled health');
    } catch (error) {
      failures++;
      console.error(`FAILED: B9.10: disable removes the capability\n  ${error.stack || error}`);
    }
  })();

  await (async () => {
    try {
      lifecycle.enable(NAME);
      assert.ok(require('../src/tools').getBuiltinRegistry().has('synthetic_metric'));
      const restored = toolJson(await callInternalTool('synthetic_metric', { value: 2 }));
      assert.strictEqual(restored.result, 6);
      console.log('Passed: B9.11: re-enable restores the capability');
    } catch (error) {
      failures++;
      console.error(`FAILED: B9.11: re-enable restores the capability\n  ${error.stack || error}`);
    }
  })();

  // --- B9.12 upgrade with visibly changed behavior -------------------------
  await (async () => {
    try {
      const before = repository.getModule(NAME);
      const upgraded = lifecycle.upgrade(NAME, V2);
      assert.strictEqual(upgraded.previous_version, '1.0.0');
      assert.strictEqual(upgraded.version, '2.0.0');
      assert.strictEqual(upgraded.active, true);
      const record = repository.getModule(NAME);
      assert.strictEqual(record.install_path, store.versionDir(NAME, '2.0.0'));
      assert.notStrictEqual(record.package_hash, before.package_hash);
      assert.deepStrictEqual(record.config, { label: 'alpha', factor: 3 }, 'compatible configuration is preserved');
      assert.strictEqual(fs.existsSync(store.versionDir(NAME, '1.0.0')), false, 'superseded version removed after activation');

      const after = toolJson(await callInternalTool('synthetic_metric', { value: 2 }));
      assert.strictEqual(after.api, 'v2');
      assert.strictEqual(after.result, 1006, 'upgraded code is what actually executes');
      console.log('Passed: B9.12: upgrade activates the new version and changes behavior');
    } catch (error) {
      failures++;
      console.error(`FAILED: B9.12: upgrade activates the new version\n  ${error.stack || error}`);
    }
  })();

  test('B9.13: ambiguous replacement is refused unless explicitly allowed', () => {
    assert.throws(() => lifecycle.upgrade(NAME, V2), /already at version 2\.0\.0/);
    assert.throws(() => lifecycle.upgrade(NAME, V1), /must increase version/);
    // The refusal must not have disturbed the working installation.
    assert.strictEqual(repository.getModule(NAME).version, '2.0.0');
    assert.strictEqual(loader.isModuleActive(NAME), true);
  });

  // --- B9.14 tamper detection ---------------------------------------------
  await (async () => {
    try {
      const record = repository.getModule(NAME);
      const entryFile = path.join(record.install_path, 'entry.js');
      fs.chmodSync(entryFile, 0o640);
      const original = fs.readFileSync(entryFile);
      fs.writeFileSync(entryFile, `${original}\nglobalThis.__SIDEKICK_TAMPER_EXECUTED__ = true;\n`);

      lifecycle.disable(NAME);
      let enableError = null;
      try { lifecycle.enable(NAME); } catch (error) { enableError = error; }
      assert.ok(enableError, 'a tampered package must not enable');
      assert.match(enableError.message, /integrity check failed|hash does not match/);
      assert.strictEqual(globalThis.__SIDEKICK_TAMPER_EXECUTED__, undefined, 'tampered code must never execute');
      assert.strictEqual(loader.isModuleActive(NAME), false);
      assert.strictEqual(require('../src/tools').getBuiltinRegistry().has('synthetic_metric'), false);

      const health = lifecycle.health(NAME);
      assert.strictEqual(health.status, 'integrity_failure');
      assert.strictEqual(health.ok, false);

      // Verified independently of the loader too.
      const verdict = entryLoader.verifyInstalledPackage(repository.getModule(NAME));
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.code, 'integrity_failure');

      fs.writeFileSync(entryFile, original);
      console.log('Passed: B9.14: mutation after install fails closed before any code runs');
    } catch (error) {
      failures++;
      console.error(`FAILED: B9.14: mutation after install fails closed\n  ${error.stack || error}`);
    }
  })();

  test('B9.15: restoring the original bytes restores loadability', () => {
    const result = lifecycle.enable(NAME);
    assert.strictEqual(result.module.state, 'enabled');
    assert.strictEqual(lifecycle.health(NAME).status, 'healthy');
  });

  // --- B9.16 built-in descriptor collision --------------------------------
  test('B9.16: a package that shadows a built-in tool is refused at inspection and install', () => {
    const collision = lifecycle.inspect(COLLIDE);
    assert.strictEqual(collision.installable, false);
    assert.ok(collision.problems.some(p => /conflicts with an existing registered tool/.test(p)), collision.problems.join('; '));
    assert.throws(() => lifecycle.install(COLLIDE), /cannot be installed/);
    assert.strictEqual(repository.getModule('synthetic-collider'), null, 'nothing is registered for a refused package');
    // The built-in is untouched.
    assert.strictEqual(require('../src/tools').getBuiltinRegistry().get('bash').source !== 'module:synthetic-collider', true);
  });

  // --- B9.17 uninstall ----------------------------------------------------
  await (async () => {
    try {
      const record = repository.getModule(NAME);
      const installPath = record.install_path;
      const result = lifecycle.uninstall(NAME);
      assert.strictEqual(result.package_removed, true);
      assert.strictEqual(result.registration_removed, true);
      assert.strictEqual(result.audit_preserved, true);
      assert.strictEqual(repository.getModule(NAME), null);
      assert.strictEqual(fs.existsSync(installPath), false, 'managed package files removed');
      assert.strictEqual(fs.existsSync(store.moduleDir(NAME)), false);
      assert.strictEqual(loader.isModuleActive(NAME), false);
      assert.strictEqual(require('../src/tools').getBuiltinRegistry().has('synthetic_metric'), false);
      const gone = await callInternalTool('synthetic_metric', {});
      assert.strictEqual(gone.isError, true);

      // Historical evidence survives the uninstall.
      const db = require('../src/db').getDb();
      const events = db.prepare(
        "SELECT COUNT(*) AS n FROM platform_execution_events WHERE subject_type = 'module' AND subject_id = ?"
      ).get(NAME);
      assert.ok(events.n > 0, 'module lifecycle events are retained after uninstall');
      const logs = db.prepare("SELECT COUNT(*) AS n FROM tool_logs WHERE tool_name = 'synthetic_metric'").get();
      assert.ok(logs.n > 0, 'tool invocation history is retained after uninstall');
      console.log('Passed: B9.17: uninstall removes capability and package but preserves audit history');
    } catch (error) {
      failures++;
      console.error(`FAILED: B9.17: uninstall\n  ${error.stack || error}`);
    }
  })();

  test('B9.18a: a tampered install_path pointing outside the managed store fails closed', () => {
    // Defence in depth: the recorded path is data, and data can be wrong or
    // hostile. Loading must not become "require anything on the server", and
    // uninstall must not become "recursively delete anything on the server".
    lifecycle.install(V1, { provenance: { installed_by: 'b9-test' } });
    lifecycle.configure(NAME, { label: 'beta' });
    const outside = path.join(TEST_DATA_DIR, 'outside-store');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'entry.js'), 'globalThis.__SIDEKICK_ESCAPED__ = true;\nmodule.exports = { buildDescriptors: () => [] };\n');
    fs.writeFileSync(path.join(outside, 'manifest.json'), '{}');

    const record = repository.getModule(NAME);
    require('../src/db').getDb()
      .prepare('UPDATE platform_modules SET install_path = ? WHERE module_id = ?')
      .run(outside, record.module_id);

    let enableError = null;
    try { lifecycle.enable(NAME); } catch (error) { enableError = error; }
    assert.ok(enableError, 'a module installed outside the managed store must not load');
    assert.match(enableError.message, /outside the managed module store/);
    assert.strictEqual(globalThis.__SIDEKICK_ESCAPED__, undefined, 'out-of-store code must never execute');
    assert.strictEqual(lifecycle.health(NAME).status, 'integrity_failure');

    // Uninstall must not delete the out-of-store directory either: removal is
    // derived from the module NAME inside the store, never from this column.
    lifecycle.uninstall(NAME);
    assert.strictEqual(fs.existsSync(path.join(outside, 'entry.js')), true, 'uninstall must not delete files outside the managed store');
    assert.throws(() => store.removeDirectory(outside), /Refusing to remove a path outside the managed module store/);
  });

  test('B9.18: builtin modules cannot be uninstalled through the third-party path', () => {
    const builtin = repository.getModule('data-utilities');
    if (!builtin) {
      require('../src/modules/builtin-modules').provisionBuiltinModules();
    }
    assert.throws(() => lifecycle.uninstall('data-utilities'), /builtin module and cannot be uninstalled/);
  });

  console.log(`\n${failures === 0 ? 'All B9 third-party module lifecycle tests passed.' : `${failures} B9 test(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
