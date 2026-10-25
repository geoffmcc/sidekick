const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runnerDataRoot = process.env.SIDEKICK_TEST_DATA_DIR;
const TEST_DATA_DIR = runnerDataRoot
  ? path.join(runnerDataRoot, 'modules-installation')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-test-modules-installation-'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
if (!runnerDataRoot) process.once('exit', () => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'modules-installation-test-secret-key';

const { discoverModules } = require('../src/modules/discovery');
const { installDiscoveredModule } = require('../src/modules/installation');
const { configureInstalledModule } = require('../src/modules/configuration');
const { activateConfiguredModule } = require('../src/modules/activation');
const { assertExecutionIsolation, LOAD_FAILURES } = require('../src/modules/entry-loader');
const loader = require('../src/modules/loader');
const repository = require('../src/modules/repository');

const root = fs.mkdtempSync(path.join(__dirname, 'test-data-discovered-module-'));
process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  name: 'installed-module',
  version: '1.0.0',
  description: 'Installed module',
  configSchema: { type: 'object', properties: { retention_days: { type: 'integer', minimum: 1 } }, required: ['retention_days'], additionalProperties: false },
  tools: {},
}));
fs.writeFileSync(path.join(root, 'entry.js'), 'module.exports = {};\n');

const candidate = discoverModules(path.dirname(root), { directories: ['.'] }).candidates.find(item => item.manifest.name === 'installed-module');
const installed = installDiscoveredModule(candidate);
assert.strictEqual(installed.state, 'validated');
assert.strictEqual(installed.source, 'discovered');
assert.ok(installed.entry_hash);
assert.strictEqual(installed.entry_point, path.relative(process.cwd(), path.join(root, 'entry.js')).replace(/\\/g, '/'));
const installedState = repository.transitionModule('installed-module', 'installed');
assert.strictEqual(installedState.state, 'installed');
assert.throws(() => configureInstalledModule('installed-module', { retention_days: 0 }), /config is invalid/);
assert.throws(() => activateConfiguredModule('installed-module', { buildDescriptors: () => [] }), /must be configured before activation/);
const configured = configureInstalledModule('installed-module', { retention_days: 30 });
assert.strictEqual(configured.state, 'configured');
assert.deepStrictEqual(configured.config, { retention_days: 30 });
assert.throws(() => configureInstalledModule('installed-module', { retention_days: 60 }), /must be installed before configuration/);
const binding = repository.getModule('installed-module');
assert.throws(
  () => activateConfiguredModule('installed-module', {
    entryPoint: binding.entry_point,
    entryHash: binding.entry_hash,
    buildDescriptors: () => [],
  }),
  error => error.code === LOAD_FAILURES.ISOLATION_UNAVAILABLE
);
assert.throws(
  () => assertExecutionIsolation(binding),
  error => error.code === LOAD_FAILURES.ISOLATION_UNAVAILABLE
);
assert.strictEqual(loader.isModuleActive('installed-module'), false);
assert.strictEqual(repository.getModule('installed-module').state, 'configured');
assert.throws(() => installDiscoveredModule(candidate), /already registered/);
fs.rmSync(root, { recursive: true, force: true });
try { require('../src/db').closeDatabase(); } catch {}

console.log('Module installation tests passed');
