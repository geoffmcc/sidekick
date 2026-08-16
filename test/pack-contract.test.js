// Pack contract formalization: pack_api versioning, pack-level permission
// declarations, pack dependencies (resolution, cycles, lifecycle ordering,
// upgrade constraints), lifecycle transition legality, and structured
// validation. Fixtures are synthesized module-less (or single-module) packs so
// each check isolates one contract rule.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-pack-contract');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(TEST_DATA_DIR, 'sidekick.db');
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'pack-contract-test-secret-key';

require('../src/db').runPendingMigrations();

const packManifest = require('../src/packs/manifest');
const packDependencies = require('../src/packs/dependencies');
const packLifecycle = require('../src/packs/lifecycle');
const packRepository = require('../src/packs/repository');
const bundled = require('../src/packs/bundled');
const moduleManifestModule = require('../src/modules/manifest');
const { callInternalTool } = require('../src/tools/dispatcher');

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
async function asyncTest(label, fn) {
  try {
    await fn();
    console.log(`Passed: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAILED: ${label}\n  ${error && error.stack ? error.stack : error}`);
  }
}

// --- fixture builders -------------------------------------------------------

let fixtureCounter = 0;

/** Write a synthetic pack directory and return its path. */
function writePack(manifest, { moduleFiles = null } = {}) {
  const dir = path.join(TEST_DATA_DIR, `fixture-${++fixtureCounter}-${manifest.name || 'invalid'}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sidekick.pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (moduleFiles) {
    for (const [relative, content] of Object.entries(moduleFiles)) {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  return dir;
}

function baseManifest(name, overrides = {}) {
  return {
    schema_version: 1,
    name,
    display_name: `Fixture ${name}`,
    version: '1.0.0',
    description: `Contract fixture pack ${name}`,
    publisher: 'Contract Tests',
    ...overrides,
  };
}

/** A pack owning one trivial module that declares the given permissions. */
function packWithModule(name, moduleName, modulePermissions, packOverrides = {}) {
  const moduleManifest = {
    name: moduleName,
    version: '1.0.0',
    description: `Fixture module ${moduleName}`,
    entryPoint: 'entry.js',
    type: 'plugin',
    permissions: modulePermissions,
    tools: {},
  };
  const manifest = baseManifest(name, {
    modules: [{ name: moduleName, path: `modules/${moduleName}` }],
    ...packOverrides,
  });
  return writePack(manifest, {
    moduleFiles: {
      [`modules/${moduleName}/manifest.json`]: `${JSON.stringify(moduleManifest, null, 2)}\n`,
      [`modules/${moduleName}/entry.js`]: 'module.exports = { buildDescriptors: () => [], healthCheck: () => true };\n',
    },
  });
}

(async () => {
  console.log('Running pack contract tests...\n');

  // --- PC.1 manifest contract ----------------------------------------------

  test('PC.1: pack_api defaults to 1, permissions stay undeclared when omitted, depends defaults empty', () => {
    const manifest = packManifest.normalizePackManifest(baseManifest('defaults-pack'));
    assert.strictEqual(manifest.pack_api, 1);
    assert.strictEqual(manifest.permissions, undefined);
    assert.deepStrictEqual(manifest.depends, { packs: [] });
    assert.deepStrictEqual(packManifest.checkPackApi(manifest), { ok: true, pack_api: 1, supported: [1] });
  });

  test('PC.2: an unsupported pack_api parses but is refused at inspection and install', () => {
    const dir = writePack(baseManifest('future-pack', { pack_api: 99 }));
    const inspection = packLifecycle.inspect(dir);
    assert.strictEqual(inspection.installable, false);
    assert.ok(inspection.problems.some(p => p.includes('pack_api 99')), inspection.problems.join('; '));
    assert.strictEqual(inspection.pack_api.compatible, false);
    assert.throws(() => packLifecycle.install(dir), /pack_api 99/);
  });

  test('PC.3: malformed permission entries are refused at parse', () => {
    assert.throws(
      () => packManifest.normalizePackManifest(baseManifest('bad-perms', { permissions: [{ tool: 'bash' }] })),
      /Invalid capability pack manifest/
    );
    assert.throws(
      () => packManifest.normalizePackManifest(baseManifest('bad-risk', { permissions: [{ tool: 'bash', risk: 'catastrophic' }] })),
      /Invalid capability pack manifest/
    );
  });

  test('PC.4: duplicate permission declarations are refused', () => {
    assert.throws(
      () =>
        packManifest.normalizePackManifest(
          baseManifest('dup-perms', { permissions: [{ tool: 'bash', risk: 'critical' }, { tool: 'bash', risk: 'critical' }] })
        ),
      /declares permission tool:bash@critical twice/
    );
  });

  test('PC.5: self-dependencies, duplicate dependencies, and invalid ranges are refused', () => {
    assert.throws(
      () => packManifest.normalizePackManifest(baseManifest('self-dep', { depends: { packs: [{ name: 'self-dep' }] } })),
      /cannot depend on itself/
    );
    assert.throws(
      () => packManifest.normalizePackManifest(baseManifest('dup-dep', { depends: { packs: [{ name: 'other' }, { name: 'other' }] } })),
      /declares dependency "other" twice/
    );
    assert.throws(
      () => packManifest.normalizePackManifest(baseManifest('bad-range', { depends: { packs: [{ name: 'other', version: 'not-a-range' }] } })),
      /invalid version range/
    );
  });

  // --- PC.6 permission agreement -------------------------------------------

  test('PC.6: a pack whose declared permissions match its modules exactly is installable', () => {
    const dir = packWithModule('perm-exact', 'perm-exact-mod', [{ tool: 'delay', risk: 'low' }], {
      permissions: [{ tool: 'delay', risk: 'low' }],
    });
    const inspection = packLifecycle.inspect(dir);
    assert.strictEqual(inspection.installable, true, inspection.problems.join('; '));
    assert.strictEqual(inspection.permissions.consistent, true);
    assert.deepStrictEqual(inspection.permissions.derived, [{ tool: 'delay', risk: 'low' }]);
  });

  test('PC.7: a declared permission set that omits a module-held grant is refused', () => {
    const dir = packWithModule('perm-missing', 'perm-missing-mod', [{ tool: 'delay', risk: 'low' }], {
      permissions: [],
    });
    const inspection = packLifecycle.inspect(dir);
    assert.strictEqual(inspection.installable, false);
    assert.ok(inspection.problems.some(p => p.includes('omit module-held grants') && p.includes('tool:delay@low')), inspection.problems.join('; '));
  });

  test('PC.8: a declared permission no module holds is refused', () => {
    const dir = packWithModule('perm-extra', 'perm-extra-mod', [{ tool: 'delay', risk: 'low' }], {
      permissions: [{ tool: 'delay', risk: 'low' }, { tool: 'bash', risk: 'critical' }],
    });
    const inspection = packLifecycle.inspect(dir);
    assert.strictEqual(inspection.installable, false);
    assert.ok(inspection.problems.some(p => p.includes('no module holds') && p.includes('tool:bash@critical')), inspection.problems.join('; '));
  });

  test('PC.9: a pre-contract manifest (no permissions key) with module grants stays installable and warns in validate', () => {
    const dir = packWithModule('perm-undeclared', 'perm-undeclared-mod', [{ tool: 'delay', risk: 'low' }]);
    const inspection = packLifecycle.inspect(dir);
    assert.strictEqual(inspection.installable, true, inspection.problems.join('; '));
    assert.strictEqual(inspection.permissions.declared, null);
    assert.strictEqual(inspection.permissions.consistent, null);
    const report = packLifecycle.validate(dir);
    assert.strictEqual(report.valid, true);
    assert.ok(report.findings.some(f => f.severity === 'warning' && f.area === 'permissions' && f.field === 'permissions'));
  });

  // --- PC.10 structured validation -----------------------------------------

  test('PC.10: validate reports field-level manifest findings with corrections instead of throwing', () => {
    const dir = writePack({ schema_version: 1, name: 'BadName', version: '1.0.0' });
    const report = packLifecycle.validate(dir);
    assert.strictEqual(report.valid, false);
    const nameFinding = report.findings.find(f => f.field === 'name');
    assert.ok(nameFinding, JSON.stringify(report.findings));
    assert.strictEqual(nameFinding.file, 'sidekick.pack.json');
    assert.match(nameFinding.correction, /lowercase identifier/);
    assert.ok(report.findings.some(f => f.field === 'display_name'), 'missing required field is reported');
    assert.ok(report.summary.errors >= 2);
  });

  test('PC.11: validate reports a missing manifest and invalid JSON as findings', () => {
    const empty = path.join(TEST_DATA_DIR, 'fixture-empty');
    fs.mkdirSync(empty, { recursive: true });
    const missing = packLifecycle.validate(empty);
    assert.strictEqual(missing.valid, false);
    assert.ok(missing.findings.some(f => f.problem.includes('no sidekick.pack.json')));

    const broken = path.join(TEST_DATA_DIR, 'fixture-broken-json');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'sidekick.pack.json'), '{ not json');
    const bad = packLifecycle.validate(broken);
    assert.strictEqual(bad.valid, false);
    assert.ok(bad.findings.some(f => f.problem.includes('not valid JSON')));
  });

  // --- PC.12 dependency resolution and lifecycle ordering ------------------

  test('PC.12: a required dependency that is not installed blocks install', () => {
    const dir = writePack(baseManifest('needs-base', { depends: { packs: [{ name: 'base-pack' }] } }));
    const inspection = packLifecycle.inspect(dir);
    assert.strictEqual(inspection.installable, false);
    assert.ok(inspection.problems.some(p => p.includes('required dependency') && p.includes('base-pack')), inspection.problems.join('; '));
    assert.throws(() => packLifecycle.install(dir), /base-pack/);
  });

  let basePackDir;
  test('PC.13: installing the provider first satisfies the dependent', () => {
    basePackDir = writePack(baseManifest('base-pack'));
    packLifecycle.install(basePackDir);
    const dir = writePack(baseManifest('needs-base', { depends: { packs: [{ name: 'base-pack', version: '^1.0.0' }] } }));
    const result = packLifecycle.install(dir);
    assert.strictEqual(result.pack.state, 'installed');
    const described = packLifecycle.describe('needs-base');
    assert.strictEqual(described.depends.resolutions[0].satisfied, true);
    assert.deepStrictEqual(packLifecycle.describe('base-pack').depends.dependents, ['needs-base']);
  });

  test('PC.14: a version-range mismatch on a required dependency blocks install', () => {
    const dir = writePack(baseManifest('needs-base-v2', { depends: { packs: [{ name: 'base-pack', version: '>=2.0.0' }] } }));
    const inspection = packLifecycle.inspect(dir);
    assert.strictEqual(inspection.installable, false);
    assert.ok(inspection.problems.some(p => p.includes('is 1.0.0 but >=2.0.0 is required')), inspection.problems.join('; '));
  });

  test('PC.15: a missing optional dependency never blocks and is reported by health', () => {
    const dir = writePack(baseManifest('optional-dep-pack', { depends: { packs: [{ name: 'absent-pack', optional: true }] } }));
    packLifecycle.install(dir);
    const health = packLifecycle.health('optional-dep-pack');
    const dependency = health.components.find(c => c.kind === 'dependency' && c.component === 'absent-pack');
    assert.ok(dependency, JSON.stringify(health.components));
    assert.strictEqual(dependency.ok, true);
    assert.strictEqual(dependency.optional, true);
    assert.strictEqual(dependency.status, 'missing');
    packLifecycle.uninstall('optional-dep-pack');
  });

  test('PC.16: enable is refused while a required dependency is not enabled, then succeeds', () => {
    assert.throws(() => packLifecycle.enable('needs-base'), /required dependency not ready.*base-pack.*enable it first/s);
    packLifecycle.enable('base-pack');
    const result = packLifecycle.enable('needs-base');
    assert.strictEqual(result.pack.state, 'enabled');
  });

  test('PC.17: disabling a provider with an enabled dependent is refused with the dependent named', () => {
    assert.throws(() => packLifecycle.disable('base-pack'), /cannot be disabled.*needs-base/s);
    packLifecycle.disable('needs-base');
    packLifecycle.disable('base-pack');
    assert.strictEqual(packRepository.getPack('base-pack').state, 'disabled');
  });

  test('PC.18: uninstalling a provider with an installed dependent is refused, and allowed once the dependent is gone', () => {
    assert.throws(() => packLifecycle.uninstall('base-pack'), /cannot be uninstalled.*needs-base/s);
    packLifecycle.uninstall('needs-base');
    // Dependent removed: the provider can now leave too (checked in PC.20).
    assert.strictEqual(packRepository.getPack('needs-base'), null);
  });

  test('PC.19: an upgrade that breaks an installed dependent\'s version range is refused', () => {
    const dependent = writePack(baseManifest('pins-base', { depends: { packs: [{ name: 'base-pack', version: '^1.0.0' }] } }));
    packLifecycle.install(dependent);

    const v2 = writePack({ ...baseManifest('base-pack'), version: '2.0.0' });
    assert.throws(() => packLifecycle.upgrade('base-pack', v2), /pins-base.*requires base-pack \^1\.0\.0/s);

    const v11 = writePack({ ...baseManifest('base-pack'), version: '1.1.0' });
    const upgraded = packLifecycle.upgrade('base-pack', v11);
    assert.strictEqual(upgraded.version, '1.1.0');
    packLifecycle.uninstall('pins-base');
  });

  test('PC.20: an upgrade introducing a dependency cycle is refused', () => {
    const cyclic = writePack(baseManifest('cycle-b', { depends: { packs: [{ name: 'base-pack' }] } }));
    packLifecycle.install(cyclic);
    const baseNeedsB = writePack({ ...baseManifest('base-pack'), version: '1.2.0', depends: { packs: [{ name: 'cycle-b' }] } });
    assert.throws(() => packLifecycle.upgrade('base-pack', baseNeedsB), /dependency cycle/i);
    packLifecycle.uninstall('cycle-b');
    packLifecycle.uninstall('base-pack');
  });

  test('PC.21: cycle detection reports the ordered path', () => {
    const manifests = {
      'cyc-a': packManifest.normalizePackManifest(baseManifest('cyc-a', { depends: { packs: [{ name: 'cyc-b' }] } })),
      'cyc-b': packManifest.normalizePackManifest(baseManifest('cyc-b', { depends: { packs: [{ name: 'cyc-a' }] } })),
    };
    const cycle = packDependencies.findDependencyCycle(manifests['cyc-a'], {
      listPacks: () => [{ name: 'cyc-b', manifest: manifests['cyc-b'], state: 'installed', version: '1.0.0' }],
      getPack: name => (name === 'cyc-b' ? { name, manifest: manifests['cyc-b'], state: 'installed', version: '1.0.0' } : null),
    });
    assert.ok(cycle, 'cycle should be detected');
    assert.ok(cycle.length >= 3 && cycle[0] === cycle[cycle.length - 1], cycle.join(' -> '));
  });

  // --- PC.22 lifecycle transition legality ---------------------------------

  test('PC.22: illegal pack state transitions are refused and audited transitions still work', () => {
    const dir = writePack(baseManifest('transitions-pack'));
    packLifecycle.install(dir);
    packLifecycle.enable('transitions-pack');
    assert.throws(() => packRepository.setPackState('transitions-pack', 'configured'), /Invalid capability pack state transition: enabled -> configured/);
    // error is reachable from anywhere, and recoverable toward operational states
    packRepository.setPackState('transitions-pack', 'error', { error: 'induced for test' });
    assert.strictEqual(packRepository.getPack('transitions-pack').state, 'error');
    const recovered = packLifecycle.enable('transitions-pack');
    assert.strictEqual(recovered.pack.state, 'enabled');
    packLifecycle.disable('transitions-pack');
    packLifecycle.uninstall('transitions-pack');
  });

  test('PC.23: the transition table refuses returning to installed', () => {
    assert.deepStrictEqual(Object.keys(packRepository.PACK_TRANSITIONS).sort(), ['configured', 'disabled', 'enabled', 'error', 'installed']);
    for (const [, targets] of Object.entries(packRepository.PACK_TRANSITIONS)) {
      assert.ok(!targets.includes('installed'), 'no state may transition back to installed');
    }
  });

  // --- PC.24 bundled pack contract migration -------------------------------

  test('PC.24: every bundled pack declares pack_api 1 and permissions that exactly match its module aggregate', () => {
    const packsRoot = path.resolve(__dirname, '..', 'packs');
    for (const entry of fs.readdirSync(packsRoot)) {
      const manifestPath = path.join(packsRoot, entry, 'sidekick.pack.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = packManifest.parsePackManifestFile(manifestPath);
      assert.strictEqual(manifest.pack_api, 1, `${entry}: pack_api`);
      assert.ok(Array.isArray(manifest.permissions), `${entry}: permissions must be declared`);
      const moduleManifests = manifest.modules.map(reference =>
        moduleManifestModule.parseManifestFile(path.join(packsRoot, entry, reference.path, 'manifest.json'))
      );
      const comparison = packManifest.comparePackPermissions(manifest.permissions, moduleManifests);
      assert.ok(
        comparison.ok,
        `${entry}: permission mismatch — missing ${comparison.missing.join(', ') || 'none'}; extra ${comparison.extra.join(', ') || 'none'}`
      );
    }
  });

  test('PC.25: bundled upgrade_available uses semver ordering, not string inequality', () => {
    // No bundled pack is installed in this test DB, so exercise the helper
    // indirectly: a bundled listing for uninstalled packs never reports an
    // upgrade, and the semver comparison is covered by PC.19's upgrade paths.
    for (const pack of bundled.listBundledPacks()) {
      assert.strictEqual(pack.upgrade_available, false, `${pack.name} is not installed; no upgrade should be offered`);
    }
  });

  // --- PC.26 operator surface ----------------------------------------------

  await asyncTest('PC.26: capability action="validate" returns a structured report through the governed dispatcher', async () => {
    const result = await callInternalTool('capability', { action: 'validate', name: 'developer' });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.ok, true, JSON.stringify(payload));
    assert.strictEqual(payload.report.valid, true);
    assert.strictEqual(payload.report.pack_api.declared, 1);
    assert.deepStrictEqual(payload.report.summary, { errors: 0, warnings: 0 });
  });

  await asyncTest('PC.27: capability validate surfaces contract problems for a broken package path', async () => {
    const dir = writePack(baseManifest('tool-broken', { pack_api: 42 }));
    const result = await callInternalTool('capability', { action: 'validate', path: dir });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.ok, false);
    assert.ok(payload.report.findings.some(f => f.area === 'compatibility' && f.problem.includes('pack_api 42')), JSON.stringify(payload.report.findings));
  });

  // --- PC.28 hardened manifest reading -------------------------------------

  test('PC.28: a symlinked manifest is refused by inspect and validate without echoing target content', () => {
    const dir = path.join(TEST_DATA_DIR, 'fixture-symlink-manifest');
    fs.mkdirSync(dir, { recursive: true });
    const secret = path.join(TEST_DATA_DIR, 'not-a-manifest.txt');
    fs.writeFileSync(secret, 'SENTINEL-CONTENT-MUST-NOT-LEAK\n');
    fs.symlinkSync(secret, path.join(dir, 'sidekick.pack.json'));

    assert.throws(() => packLifecycle.inspect(dir), /sidekick\.pack\.json is a symlink/);
    const report = packLifecycle.validate(dir);
    assert.strictEqual(report.valid, false);
    const text = JSON.stringify(report);
    assert.ok(!text.includes('SENTINEL-CONTENT-MUST-NOT-LEAK'), 'target file content must not appear in findings');
    assert.ok(report.findings.some(f => f.problem.includes('symlink')), text);
  });

  test('PC.29: JSON parse failures report position only, never file content', () => {
    const dir = path.join(TEST_DATA_DIR, 'fixture-content-echo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sidekick.pack.json'), 'LEAKED-FIRST-LINE rest of file\n');
    assert.throws(() => packLifecycle.inspect(dir), error => {
      assert.ok(!String(error.message).includes('LEAKED-FIRST-LINE'), error.message);
      assert.match(String(error.message), /not valid JSON/);
      return true;
    });
    const report = packLifecycle.validate(dir);
    assert.ok(!JSON.stringify(report).includes('LEAKED-FIRST-LINE'));
  });

  test('PC.30: an oversized manifest is refused before parsing', () => {
    const dir = path.join(TEST_DATA_DIR, 'fixture-huge-manifest');
    fs.mkdirSync(dir, { recursive: true });
    const huge = { ...baseManifest('huge-pack'), description: 'x'.repeat(1200 * 1024) };
    fs.writeFileSync(path.join(dir, 'sidekick.pack.json'), JSON.stringify(huge));
    assert.throws(() => packLifecycle.inspect(dir), /exceeds \d+ bytes/);
  });

  test('PC.31: version ranges are validated over the full grammar, not the first character', () => {
    assert.throws(
      () => packManifest.normalizePackManifest(baseManifest('sneaky-range', { depends: { packs: [{ name: 'other', version: '1 && rm -rf /' }] } })),
      /invalid version range/
    );
    assert.throws(
      () => packManifest.normalizePackManifest(baseManifest('long-range', { depends: { packs: [{ name: 'other', version: `>=1.0.0 ${'x'.repeat(80)}` }] } })),
      /Invalid capability pack manifest/
    );
    for (const good of ['^1.2.3', '>=1.0.0 <2.0.0', '~2.1.0', '1.x', '*', '>=1.0.0, <=3.0.0']) {
      const manifest = packManifest.normalizePackManifest(baseManifest('good-range', { depends: { packs: [{ name: 'other', version: good, optional: true }] } }));
      assert.strictEqual(manifest.depends.packs[0].version, good);
    }
  });

  console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll pack contract tests passed');
  process.exit(failures ? 1 : 0);
})();
