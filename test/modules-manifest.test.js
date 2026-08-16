const assert = require('assert');

process.env.SIDEKICK_DATA_DIR = require('path').join(__dirname, 'test-data-modules-manifest');

const {
  normalizeManifest,
  parseManifestFile,
  parseVersion,
  compareVersions,
  satisfiesVersion,
  validateModuleConfig,
  checkManifestOwnership,
  verifyModuleTools,
} = require('../src/modules/manifest');

console.log('Running Module Manifest Contract Tests...');

const validManifest = {
  name: 'data-utilities',
  version: '1.0.0',
  sidekick: '>=0.40.0',
  description: 'In-process data parsing, transformation, validation and template utilities',
  author: 'sidekick',
  type: 'builtin',
  capabilities: ['data-utilities'],
  configSchema: null,
  permissions: [],
  tools: {
    parse: { risk: 'low' },
    extract: { risk: 'medium' },
    transform: { risk: 'low' },
    diff: { risk: 'low', aliases: ['compare'] },
    validate: { risk: 'low' },
    template: { risk: 'low' },
  },
  migrations: [],
};

let failed = 0;
function check(condition, message) {
  if (!condition) {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

try {
  // --- Normalization: defaults, freezing, contract version ---
  const manifest = normalizeManifest(validManifest);
  check(manifest.name === 'data-utilities', 'name preserved');
  check(manifest.type === 'builtin', 'type preserved');
  check(manifest.dependencies.length === 0, 'dependencies default to empty');
  check(manifest.optionalDependencies.length === 0, 'optionalDependencies default to empty');
  check(manifest.permissions.length === 0, 'permissions default to empty');
  check(manifest.workflows.length === 0, 'workflows default to empty');
  check(manifest.agents.length === 0, 'agents default to empty');
  check(manifest.connectors.length === 0, 'connectors default to empty');
  check(manifest.dashboard.length === 0, 'dashboard default to empty');
  check(manifest.backgroundServices.length === 0, 'backgroundServices default to empty');
  check(manifest.lifecycle.disable === 'stop_new_work', 'lifecycle.disable default');
  check(manifest.lifecycle.uninstall === 'retain_data', 'lifecycle.uninstall default');
  check(manifest.retention === 'default', 'retention default');
  check(manifest.events.publishes.length === 0 && manifest.events.consumes.length === 0, 'events default to empty');
  check(manifest.tools.parse.risk === 'low', 'tool declaration risk preserved');
  check(manifest.tools.diff.aliases.includes('compare'), 'tool declaration alias preserved');
  const permissionManifest = normalizeManifest({ ...validManifest, tools: { parse: { risk: 'low', permission: 'packs.read' } } });
  check(permissionManifest.tools.parse.permission === 'packs.read', 'Core permission declaration preserved');

  // --- Validation failures ---
  checkThrows(() => normalizeManifest({ ...validManifest, name: 'Data-Utilities' }), 'uppercase name rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, name: 'data_utilities' }), 'underscore module name rejected (modules use dashes)');
  checkThrows(() => normalizeManifest({ ...validManifest, version: 'not-a-version' }), 'non-semver version rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, description: '' }), 'empty description rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, type: 'evil' }), 'invalid type rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, sidekick: 'not a range' }), 'invalid sidekick range rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, tools: { parse: { risk: 'extreme' } } }), 'invalid tool risk rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, tools: { parse: { risk: 'low', aliases: ['bad-alias!'] } } }), 'invalid alias rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, tools: { parse: { risk: 'low', permission: 'not-a-permission' } } }), 'invalid Core permission rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, migrations: [{ name: 'a', sql: 'SELECT 1' }, { name: 'a', sql: 'SELECT 2' }] }), 'duplicate migration names rejected');
  checkThrows(() => normalizeManifest({ ...validManifest, permissions: [{ tool: 'parse', risk: 'extreme' }] }), 'permission tool risk validated');
  checkThrows(() => normalizeManifest({ ...validManifest, permissions: [{ capability: '' }] }), 'empty capability permission rejected');

  // --- Semver ---
  check(parseVersion('1.2.3').major === 1, 'parseVersion major');
  check(parseVersion('1.2.3').minor === 2, 'parseVersion minor');
  check(parseVersion('1.2.3').patch === 3, 'parseVersion patch');
  check(parseVersion('not-semver') === null, 'parseVersion rejects garbage');
  check(compareVersions('1.2.3', '1.2.4') === -1, 'compareVersions ascending');
  check(compareVersions('2.0.0', '1.9.9') === 1, 'compareVersions major');
  check(compareVersions('1.0.0', '1.0.0') === 0, 'compareVersions equal');
  check(satisfiesVersion('0.41.0', '>=0.40.0'), 'sidekick range >= satisfied');
  check(!satisfiesVersion('0.39.0', '>=0.40.0'), 'sidekick range >= not satisfied');
  check(satisfiesVersion('1.2.5', '^1.2.0'), 'caret satisfied');
  check(!satisfiesVersion('2.0.0', '^1.2.0'), 'caret not satisfied (major bump)');
  check(satisfiesVersion('1.2.3', '*'), 'star range satisfied');
  check(satisfiesVersion('1.2.3', '1.2.3'), 'exact range satisfied');
  check(satisfiesVersion('1.5.0', '>=1.0.0 <2.0.0'), 'conjunctive range satisfied');
  check(!satisfiesVersion('2.5.0', '>=1.0.0 <2.0.0'), 'conjunctive range not satisfied');

  // --- Config validation ---
  const configured = normalizeManifest({
    ...validManifest,
    configSchema: { type: 'object', properties: { maxDepth: { type: 'number', minimum: 1 } }, required: [], additionalProperties: false },
  });
  check(validateModuleConfig(configured, {}).ok, 'empty config valid against schema');
  check(validateModuleConfig(configured, { maxDepth: 5 }).ok, 'valid config accepted');
  const invalidConfig = validateModuleConfig(configured, { maxDepth: -1 });
  check(!invalidConfig.ok, 'invalid config rejected');
  check(invalidConfig.errors.length > 0, 'invalid config reports errors');
  check(validateModuleConfig(manifest, null).ok, 'no configSchema accepts null config');

  // --- Ownership (fail closed) ---
  const ownerCheck = checkManifestOwnership(manifest, {
    toolNames: ['parse', 'read'],
    aliases: [],
    installedModules: ['memory-core'],
  });
  check(!ownerCheck.ok, 'duplicate tool name fails closed');
  check(ownerCheck.errors.some(e => e.includes('parse')), 'duplicate error names the tool');

  const cleanOwner = checkManifestOwnership(manifest, { toolNames: ['read'], aliases: [], installedModules: [] });
  check(cleanOwner.ok, 'no collision passes');

  const aliasCollision = checkManifestOwnership(manifest, { toolNames: [], aliases: ['compare'], installedModules: [] });
  check(!aliasCollision.ok, 'alias collision fails closed');

  const dupModule = checkManifestOwnership(manifest, { toolNames: [], aliases: [], installedModules: ['data-utilities'] });
  check(!dupModule.ok, 'duplicate module name fails closed');

  // --- verifyModuleTools: descriptor ownership must match declarations ---
  const descriptors = Object.entries(manifest.tools).map(([name, declaration]) => ({
    name,
    risk: declaration.risk,
    aliases: declaration.aliases,
  }));
  check(verifyModuleTools(manifest, descriptors).ok, 'matching descriptors pass');

  const mismatched = verifyModuleTools(manifest, [{ ...descriptors[0], risk: 'high' }]);
  check(!mismatched.ok, 'risk mismatch fails closed');
  check(mismatched.errors.some(e => e.includes('risk')), 'risk mismatch names the discrepancy');

  const undeclared = verifyModuleTools(manifest, [...descriptors, { name: 'sneaky', risk: 'low', aliases: [] }]);
  check(!undeclared.ok, 'undeclared provided tool fails closed');

  const missing = verifyModuleTools(manifest, descriptors.filter(d => d.name !== 'parse'));
  check(!missing.ok, 'declared but unprovided tool fails closed');

  const undeclaredAlias = verifyModuleTools(manifest, [{ ...descriptors[0], aliases: ['rogue'] }]);
  check(!undeclaredAlias.ok, 'undeclared alias fails closed');

  // --- parseManifestFile ---
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = path.join(os.tmpdir(), 'modules-manifest-test-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(validManifest, null, 2), 'utf8');
  const fromFile = parseManifestFile(file);
  check(fromFile.name === 'data-utilities', 'parseManifestFile reads and normalizes');
  checkThrows(() => parseManifestFile(path.join(dir, 'missing.json')), 'parseManifestFile rejects missing file');
  fs.rmSync(dir, { recursive: true, force: true });
} catch (e) {
  failed++;
  console.error('  UNEXPECTED ERROR:', e.message);
  console.error(e.stack);
}

function checkThrows(fn, message) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${message} (expected throw, did not throw)`);
  } catch {
    // expected
  }
}

console.log(failed === 0 ? 'Module Manifest Contract Tests passed' : `Module Manifest Contract Tests FAILED (${failed} failure(s))`);
process.exit(failed === 0 ? 0 : 1);
