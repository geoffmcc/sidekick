const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-modules-installation');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'modules-installation-test-secret-key';

const { discoverModules } = require('../src/modules/discovery');
const { installDiscoveredModule } = require('../src/modules/installation');
const { configureInstalledModule } = require('../src/modules/configuration');
const repository = require('../src/modules/repository');

const root = path.join(process.cwd(), 'test', 'test-data-discovered-module');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
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
assert.strictEqual(installed.entry_point, 'test/test-data-discovered-module/entry.js');
const installedState = repository.transitionModule('installed-module', 'installed');
assert.strictEqual(installedState.state, 'installed');
assert.throws(() => configureInstalledModule('installed-module', { retention_days: 0 }), /config is invalid/);
const configured = configureInstalledModule('installed-module', { retention_days: 30 });
assert.strictEqual(configured.state, 'configured');
assert.deepStrictEqual(configured.config, { retention_days: 30 });
assert.throws(() => configureInstalledModule('installed-module', { retention_days: 60 }), /must be installed before configuration/);
assert.throws(() => installDiscoveredModule(candidate), /already registered/);
fs.rmSync(root, { recursive: true, force: true });

console.log('Module installation tests passed');
