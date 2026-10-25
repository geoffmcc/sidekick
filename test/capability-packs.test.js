// Capability Packs v1: pack lifecycle end to end against the bundled
// first-party Developer pack, plus the ownership and integrity properties that
// make the lifecycle coherent.
//
// The Developer pack is the real production consumer, so it is also the
// lifecycle fixture: everything asserted here is exercised on the same pack an
// operator installs.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runnerDataRoot = process.env.SIDEKICK_TEST_DATA_DIR;
const TEST_DATA_DIR = runnerDataRoot
  ? path.join(runnerDataRoot, 'capability-packs')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-test-capability-packs-'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
if (!runnerDataRoot) process.once('exit', () => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(TEST_DATA_DIR, 'sidekick.db');
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'capability-packs-test-secret-key';
process.env.SIDEKICK_ALLOWED_PATHS = process.cwd();

require('../src/db').runPendingMigrations();

const packLifecycle = require('../src/packs/lifecycle');
const packRepository = require('../src/packs/repository');
const packStore = require('../src/packs/store');
const bundled = require('../src/packs/bundled');
const moduleRepository = require('../src/modules/repository');
const moduleLoader = require('../src/modules/loader');
const moduleLifecycle = require('../src/modules/lifecycle');
const moduleStore = require('../src/modules/store');
const workflowRepository = require('../src/workflows/repository');
const dbStore = require('../src/db');
const { callInternalTool } = require('../src/tools/dispatcher');
const authorizedContext = require('./helpers/authorized-context').createOwnerContext({ source: 'internal' });

const PACK = 'developer';
const BUNDLED_PATH = path.resolve(__dirname, '..', 'packs', 'developer');
const UPGRADE_DIR = path.join(TEST_DATA_DIR, 'developer-1.1.0');
const FIXTURE_UPGRADE_DIR = path.join(TEST_DATA_DIR, 'fixture-observatory-1.1.0');

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

function registry() {
  return require('../src/tools').getBuiltinRegistry();
}

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

test('pack store recovery removes only abandoned staging directories', () => {
  const staging = packStore.stagePackFiles('recovery-fixture', BUNDLED_PATH, ['sidekick.pack.json']);
  assert.ok(fs.existsSync(staging));
  const version = packStore.versionDir('recovery-fixture', '9.9.9');
  fs.mkdirSync(version, { recursive: true });
  const removed = packStore.recoverStaging('recovery-fixture');
  assert.deepStrictEqual(removed, [staging]);
  assert.strictEqual(fs.existsSync(staging), false);
  assert.strictEqual(fs.existsSync(version), true, 'recovery must not remove installed versions');
  packStore.removeDirectory(version);
  fs.rmSync(packStore.packDir('recovery-fixture'), { recursive: true, force: true });
});

/** Build a v1.1.0 upgrade candidate that drops one workflow and adds knowledge. */
function buildUpgradeCandidate() {
  copyTree(BUNDLED_PATH, UPGRADE_DIR);
  const manifestPath = path.join(UPGRADE_DIR, 'sidekick.pack.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest.version = '1.1.0';
  // Drop the release-preparation workflow to prove obsolete components are removed.
  manifest.workflows = manifest.workflows.filter(entry => !entry.path.includes('release-preparation'));
  fs.rmSync(path.join(UPGRADE_DIR, 'workflows', 'release-preparation.json'));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Bump the owned module so the module upgrade path runs too.
  const moduleManifestPath = path.join(UPGRADE_DIR, 'modules', 'developer-tools', 'manifest.json');
  const moduleManifest = JSON.parse(fs.readFileSync(moduleManifestPath, 'utf-8'));
  moduleManifest.version = '1.1.0';
  fs.writeFileSync(moduleManifestPath, `${JSON.stringify(moduleManifest, null, 2)}\n`);
  return UPGRADE_DIR;
}

(async () => {
  console.log('Running Capability Packs v1 tests...\n');

  // --- CP.1 bundled discovery ---------------------------------------------
  test('CP.1: the Developer pack is discovered as an available bundled first-party pack', () => {
    const packs = bundled.listBundledPacks();
    const developer = packs.find(pack => pack.name === PACK);
    assert.ok(developer, 'developer pack should be bundled');
    assert.strictEqual(developer.installed, false);
    assert.strictEqual(developer.provenance, 'first_party');
    assert.strictEqual(developer.compatible, true);
    assert.strictEqual(developer.version, '1.0.1');
    assert.deepStrictEqual(developer.modules, ['developer-tools']);
    assert.strictEqual(developer.workflows, 7);
    assert.strictEqual(developer.knowledge, 10);
  });

  // --- CP.2 inspection -----------------------------------------------------
  let inspection;
  test('CP.2: pack inspection validates manifest, modules, workflows and knowledge without installing', () => {
    inspection = packLifecycle.inspect(BUNDLED_PATH);
    assert.strictEqual(inspection.installable, true, inspection.problems.join('; '));
    assert.deepStrictEqual(inspection.problems, []);
    assert.match(inspection.package_hash, /^[a-f0-9]{64}$/);
    assert.strictEqual(inspection.compatibility.compatible, true);
    assert.strictEqual(inspection.modules.length, 1);
    assert.deepStrictEqual(inspection.modules[0].tools.sort(), ['dev_change_summary', 'dev_repo_profile', 'dev_verify', 'semantic_repo']);
    assert.strictEqual(inspection.workflows.length, 7);
    assert.strictEqual(inspection.knowledge.length, 10);
    assert.deepStrictEqual(inspection.requires.missing, [], 'all required tools exist');
    assert.strictEqual(packRepository.getPack(PACK), null, 'inspection installs nothing');
  });

  test('CP.3: a pack whose workflow definition is invalid is refused at inspection', () => {
    const broken = path.join(TEST_DATA_DIR, 'broken-pack');
    copyTree(BUNDLED_PATH, broken);
    const workflowPath = path.join(broken, 'workflows', 'ci-triage.json');
    const definition = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
    // Reference a step that has not run yet: statically detectable.
    definition.steps[0].args.repo = '${steps.local_verify.json.verdict}';
    fs.writeFileSync(workflowPath, JSON.stringify(definition, null, 2));
    const result = packLifecycle.inspect(broken);
    assert.strictEqual(result.installable, false);
    assert.ok(result.problems.some(problem => /before it runs/.test(problem)), result.problems.join('; '));
  });

  // --- CP.4 install --------------------------------------------------------
  test('CP.4: install copies to the managed store, installs components and leaves the pack disabled', () => {
    const result = bundled.installBundledPack(PACK);
    const pack = packRepository.getPack(PACK);
    assert.strictEqual(pack.state, 'installed', 'a newly installed pack is not automatically enabled');
    assert.strictEqual(pack.provenance, 'first_party');
    assert.strictEqual(pack.version, '1.0.1');
    assert.strictEqual(pack.package_hash, inspection.package_hash);
    assert.strictEqual(pack.install_path, packStore.versionDir(PACK, '1.0.1'));
    assert.strictEqual(pack.source.kind, 'bundled');
    assert.ok(fs.existsSync(path.join(pack.install_path, 'sidekick.pack.json')));

    // Configuration defaults from the manifest are applied and validated.
    assert.strictEqual(pack.config.verification_mode, 'standard');
    assert.strictEqual(pack.config.autodetect_verification, true);

    // The owned module was installed through the module subsystem, into the
    // MODULE store — not duplicated by the pack implementation.
    const module = moduleRepository.getModule('developer-tools');
    assert.ok(module, 'owned module registered');
    assert.strictEqual(module.source, 'pack');
    assert.strictEqual(module.provenance.pack, PACK);
    assert.ok(moduleStore.isManagedPath(module.install_path));

    // config_from_pack propagated the pack configuration into the module.
    assert.strictEqual(module.config.verification_mode, 'standard');

    // Components are owned and recorded.
    const components = packRepository.listComponents(PACK);
    assert.strictEqual(components.filter(c => c.kind === 'module').length, 1);
    assert.strictEqual(components.filter(c => c.kind === 'workflow').length, 7);
    assert.strictEqual(components.filter(c => c.kind === 'knowledge').length, 10);

    // Nothing is live yet.
    assert.strictEqual(registry().has('dev_repo_profile'), false, 'pack tools are not active before enable');
    for (const definition of workflowRepository.listWorkflowDefinitions({ ownerKind: 'pack', ownerName: PACK })) {
      assert.strictEqual(definition.state, 'disabled', `${definition.name} should not be runnable before enable`);
    }
    assert.ok(result.install_path);
  });

  test('CP.5: installing the same pack twice is refused', () => {
    assert.throws(() => bundled.installBundledPack(PACK), /already installed/);
  });

  test('CP.6: a second pack may not claim components this pack owns', () => {
    const clone = path.join(TEST_DATA_DIR, 'clone-pack');
    copyTree(BUNDLED_PATH, clone);
    const manifestPath = path.join(clone, 'sidekick.pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.name = 'developer-clone';
    manifest.display_name = 'Developer clone';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    assert.throws(() => packLifecycle.install(clone), /ownership conflict|already registered|cannot be installed/);
    assert.strictEqual(packRepository.getPack('developer-clone'), null);
  });

  // --- CP.7 enable ---------------------------------------------------------
  test('CP.7: enable activates owned modules, workflows and knowledge, and health is healthy', () => {
    const result = packLifecycle.enable(PACK);
    assert.strictEqual(result.pack.state, 'enabled');
    assert.strictEqual(result.health.status, 'healthy');
    assert.strictEqual(result.health.ok, true);
    assert.deepStrictEqual(result.activated.modules.map(m => m.name), ['developer-tools']);
    assert.strictEqual(result.activated.workflows.length, 7);
    assert.strictEqual(result.activated.knowledge.length, 10);

    for (const tool of ['dev_repo_profile', 'dev_change_summary', 'dev_verify', 'semantic_repo']) {
      assert.ok(registry().has(tool), `${tool} should be registered`);
      assert.strictEqual(registry().get(tool).source, 'module:developer-tools', `${tool} is owned by the pack module`);
    }
    for (const definition of workflowRepository.listWorkflowDefinitions({ ownerKind: 'pack', ownerName: PACK })) {
      assert.strictEqual(definition.state, 'registered');
    }
    const knowledgeRows = dbStore.getDb()
      .prepare("SELECT COUNT(*) AS n FROM knowledge WHERE tags LIKE '%pack:developer%' AND enabled = 1")
      .get();
    assert.strictEqual(knowledgeRows.n, 10, 'pack knowledge is searchable once enabled');
  });

  test('CP.8: pack health derives from components, not from a stored flag', () => {
    const report = packLifecycle.health(PACK);
    assert.strictEqual(report.status, 'healthy');
    const byComponent = Object.fromEntries(report.components.map(c => [c.component, c]));
    assert.strictEqual(byComponent.compatibility.ok, true);
    assert.strictEqual(byComponent.configuration.ok, true);
    assert.strictEqual(byComponent['developer-tools'].status, 'healthy');
    assert.strictEqual(byComponent['developer/repository-recon'].ok, true);
    assert.strictEqual(byComponent['Developer pack: verification strategy'].ok, true);
    assert.strictEqual(report.categories.configuration.ok, true);
    assert.strictEqual(report.categories.components.ok, true);
    const diagnosis = packLifecycle.doctor(PACK);
    assert.strictEqual(diagnosis.ok, true);
    assert.deepStrictEqual(diagnosis.actions, []);
  });

  // --- CP.9 configuration --------------------------------------------------
  test('CP.9: configuration is validated, persisted and propagated to opted-in modules', () => {
    assert.throws(() => packLifecycle.configure(PACK, { verification_mode: 'nonsense' }), /configuration is invalid/);
    assert.throws(() => packLifecycle.configure(PACK, { not_a_setting: 1 }), /configuration is invalid/);

    const result = packLifecycle.configure(PACK, { verification_mode: 'quick', max_output_chars: 2000 });
    assert.strictEqual(result.pack.config.verification_mode, 'quick');
    assert.deepStrictEqual(result.propagated_to_modules, ['developer-tools']);
    assert.strictEqual(moduleRepository.getModule('developer-tools').config.verification_mode, 'quick');
    // Reconfiguring an active module rebuilds its descriptors rather than
    // leaving handlers closed over stale configuration.
    assert.ok(registry().has('dev_verify'));
    assert.strictEqual(moduleLoader.isModuleActive('developer-tools'), true);
  });

  // --- CP.10 integrity -----------------------------------------------------
  await asyncTest('CP.10: mutating an owned module after install fails the pack health closed', async () => {
    const module = moduleRepository.getModule('developer-tools');
    const entryFile = path.join(module.install_path, 'entry.js');
    const original = fs.readFileSync(entryFile);
    fs.chmodSync(entryFile, 0o640);
    fs.writeFileSync(entryFile, `${original}\n// tampered\n`);

    const report = packLifecycle.health(PACK);
    assert.strictEqual(report.status, 'integrity_failure');
    assert.strictEqual(report.ok, false);
    const moduleComponent = report.components.find(c => c.component === 'developer-tools');
    assert.strictEqual(moduleComponent.status, 'integrity_failure');

    fs.writeFileSync(entryFile, original);
    assert.strictEqual(packLifecycle.health(PACK).status, 'healthy', 'restoring the bytes restores health');
  });

  // --- CP.11 disable / re-enable -------------------------------------------
  await asyncTest('CP.11: disable removes active capabilities without destroying anything', async () => {
    packLifecycle.disable(PACK);
    assert.strictEqual(packRepository.getPack(PACK).state, 'disabled');
    assert.strictEqual(registry().has('dev_repo_profile'), false, 'pack tool descriptors are gone');
    assert.strictEqual(moduleLoader.isModuleActive('developer-tools'), false);

    const denied = await callInternalTool('dev_repo_profile', { path: process.cwd() });
    assert.strictEqual(denied.isError, true);

    for (const definition of workflowRepository.listWorkflowDefinitions({ ownerKind: 'pack', ownerName: PACK })) {
      assert.strictEqual(definition.state, 'disabled', `${definition.name} should not be runnable`);
    }
    const run = await callInternalTool('workflow', { action: 'run', name: 'developer/repository-recon', inputs: { path: process.cwd() } }, authorizedContext);
    assert.ok(/is disabled/.test(run.content[0].text), run.content[0].text);

    const enabledKnowledge = dbStore.getDb()
      .prepare("SELECT COUNT(*) AS n FROM knowledge WHERE tags LIKE '%pack:developer%' AND enabled = 1")
      .get();
    assert.strictEqual(enabledKnowledge.n, 0, 'pack knowledge is withdrawn from search');
    const retainedKnowledge = dbStore.getDb()
      .prepare("SELECT COUNT(*) AS n FROM knowledge WHERE tags LIKE '%pack:developer%'")
      .get();
    assert.strictEqual(retainedKnowledge.n, 10, 'knowledge content is retained, not deleted');

    // The definitions and the module registration survive.
    assert.ok(moduleRepository.getModule('developer-tools'));
    assert.strictEqual(workflowRepository.listWorkflowDefinitions({ ownerKind: 'pack', ownerName: PACK }).length, 7);
    assert.strictEqual(packLifecycle.health(PACK).status, 'disabled');
  });

  await asyncTest('CP.12: re-enable restores every capability', async () => {
    const result = packLifecycle.enable(PACK);
    assert.strictEqual(result.pack.state, 'enabled');
    assert.strictEqual(result.health.status, 'healthy');
    assert.ok(registry().has('dev_repo_profile'));
    const restored = await callInternalTool('dev_repo_profile', { path: process.cwd() });
    assert.strictEqual(restored.isError, undefined, restored.content[0].text.slice(0, 400));
    const enabledKnowledge = dbStore.getDb()
      .prepare("SELECT COUNT(*) AS n FROM knowledge WHERE tags LIKE '%pack:developer%' AND enabled = 1")
      .get();
    assert.strictEqual(enabledKnowledge.n, 10);
  });

  // --- CP.13 upgrade -------------------------------------------------------
  await asyncTest('CP.13: a caller-supplied package hash cannot promote modified first-party code into Core', async () => {
    const candidate = buildUpgradeCandidate();
    const sentinel = path.join(TEST_DATA_DIR, 'first-party-upgrade-executed.txt');
    const entryPath = path.join(candidate, 'modules', 'developer-tools', 'entry.js');
    fs.appendFileSync(entryPath, `\nrequire('fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`);
    const candidateHash = packLifecycle.inspect(candidate).package_hash;
    const beforePack = packRepository.getPack(PACK);
    const module = moduleRepository.getModule('developer-tools');
    const result = await callInternalTool('capability', {
      action: 'upgrade', name: PACK, path: candidate, expected_package_hash: candidateHash,
    }, authorizedContext);
    assert.match(result.content[0].text, /first_party_source_required/);
    assert.strictEqual(fs.existsSync(sentinel), false, 'candidate module entry never executes');
    const afterPack = packRepository.getPack(PACK);
    assert.strictEqual(afterPack.package_hash, beforePack.package_hash);
    assert.strictEqual(afterPack.install_path, beforePack.install_path);
    assert.strictEqual(afterPack.provenance, 'first_party');
    assert.strictEqual(moduleRepository.getModule('developer-tools').package_hash, module.package_hash);
    assert.strictEqual(moduleLoader.isModuleActive('developer-tools'), true);
    assert.ok(registry().has('dev_verify'));
  });

  test('CP.14: only a matching bundled artifact can retain first-party trust', () => {
    assert.throws(() => packLifecycle.upgrade(PACK, BUNDLED_PATH), /already at version 1\.0\.1/);
    const result = bundled.upgradeBundledPack(PACK, { allowSameVersion: true });
    assert.strictEqual(result.version, '1.0.1');
    assert.strictEqual(packRepository.getPack(PACK).provenance, 'first_party');
    assert.strictEqual(packLifecycle.health(PACK).status, 'healthy');
    assert.strictEqual(packRepository.getPack(PACK).version, '1.0.1', 'a refused replacement leaves the release version installed');
  });

  // --- CP.15 uninstall -----------------------------------------------------
  await asyncTest('CP.15: uninstall removes every active capability and the managed package, preserving history', async () => {
    const pack = packRepository.getPack(PACK);
    const packPath = pack.install_path;
    const module = moduleRepository.getModule('developer-tools');
    const modulePath = module.install_path;

    const result = packLifecycle.uninstall(PACK);
    assert.deepStrictEqual(result.removed.modules, ['developer-tools']);
    assert.strictEqual(result.removed.workflows.length, 7);
    assert.strictEqual(result.removed.knowledge.length, 10);
    assert.strictEqual(result.package_removed, true);
    assert.strictEqual(result.audit_preserved, true);

    assert.strictEqual(packRepository.getPack(PACK), null);
    assert.strictEqual(moduleRepository.getModule('developer-tools'), null);
    assert.strictEqual(fs.existsSync(packPath), false);
    assert.strictEqual(fs.existsSync(modulePath), false);
    assert.strictEqual(registry().has('dev_repo_profile'), false);
    assert.strictEqual(workflowRepository.listWorkflowDefinitions({ ownerKind: 'pack', ownerName: PACK }).length, 0);
    assert.strictEqual(packRepository.listComponents(PACK).length, 0);

    const knowledgeRows = dbStore.getDb().prepare("SELECT COUNT(*) AS n FROM knowledge WHERE tags LIKE '%pack:developer%'").get();
    assert.strictEqual(knowledgeRows.n, 0);

    const gone = await callInternalTool('dev_verify', { path: process.cwd() });
    assert.strictEqual(gone.isError, true);

    // Historical evidence survives.
    const toolLogs = dbStore.getDb().prepare("SELECT COUNT(*) AS n FROM tool_logs WHERE tool_name = 'dev_repo_profile'").get();
    assert.ok(toolLogs.n > 0, 'tool invocation history is retained after uninstall');
    const packEvents = dbStore.getDb()
      .prepare("SELECT COUNT(*) AS n FROM platform_execution_events WHERE subject_type = 'capability_pack' AND subject_id = ?")
      .get(PACK);
    assert.ok(packEvents.n > 0, 'pack lifecycle events are retained after uninstall');
  });

  // --- CP.16 reinstall after uninstall -------------------------------------
  test('CP.16: the pack can be installed again cleanly after uninstall', () => {
    bundled.installBundledPack(PACK, { enable: true });
    const pack = packRepository.getPack(PACK);
    assert.strictEqual(pack.state, 'enabled');
    assert.strictEqual(pack.version, '1.0.1');
    assert.strictEqual(packLifecycle.health(PACK).status, 'healthy');
    assert.ok(registry().has('dev_repo_profile'));
  });

  // --- CP.17 third-party provenance ----------------------------------------
  // Every other test installs through the bundled path, which stamps
  // first_party — so the third_party default of packLifecycle.install() was
  // never exercised. A purpose-built fixture pack (NOT a copy of a bundled
  // pack: distinct name, one trivial self-contained tool) proves the whole
  // lifecycle under third-party provenance.
  await asyncTest('CP.17: a third-party pack installs but cannot activate executable code', async () => {
    const fixture = path.resolve(__dirname, 'fixtures', 'third-party-pack');
    const inspectionResult = packLifecycle.inspect(fixture);
    assert.strictEqual(inspectionResult.installable, true, inspectionResult.problems.join('; '));

    packLifecycle.install(fixture);
    const pack = packRepository.getPack('fixture-observatory');
    assert.ok(pack, 'fixture pack registered');
    assert.strictEqual(pack.provenance, 'third_party', 'a non-bundled install records third_party provenance');
    assert.strictEqual(pack.state, 'installed', 'install does not auto-enable');
    assert.strictEqual(registry().has('fixture_observation'), false, 'tool not active before enable');

    assert.throws(() => packLifecycle.enable('fixture-observatory'), /OS-enforced module isolation is unavailable/);
    assert.strictEqual(packRepository.getPack('fixture-observatory').state, 'installed');
    assert.strictEqual(moduleLoader.isModuleActive('observatory-tools'), false);
    assert.strictEqual(registry().has('fixture_observation'), false, 'untrusted tool never enters the Core registry');

    // Uninstall remains available for a package that cannot be activated.
    const removed = packLifecycle.uninstall('fixture-observatory');
    assert.deepStrictEqual(removed.removed.modules, ['observatory-tools']);
    assert.strictEqual(packRepository.getPack('fixture-observatory'), null);
    assert.strictEqual(moduleRepository.getModule('observatory-tools'), null);
    assert.strictEqual(registry().has('fixture_observation'), false);
  });

  test('CP.18: failed module teardown does not falsely disable or uninstall a live trusted pack', () => {
    packLifecycle.enable(PACK);
    assert.strictEqual(moduleLoader.isModuleActive('developer-tools'), true);

    const originalDisable = moduleLifecycle.disable;
    moduleLifecycle.disable = () => { throw new Error('simulated teardown failure'); };
    try {
      assert.throws(
        () => packLifecycle.disable(PACK),
        /could not be disabled: developer-tools: simulated teardown failure/
      );
      assert.strictEqual(packRepository.getPack(PACK).state, 'enabled');
      assert.strictEqual(moduleLoader.isModuleActive('developer-tools'), true);

      assert.throws(
        () => packLifecycle.uninstall(PACK),
        /could not be disabled: developer-tools: simulated teardown failure/
      );
      assert.ok(packRepository.getPack(PACK), 'failed uninstall preserves the pack record');
      assert.ok(moduleRepository.getModule('developer-tools'), 'failed uninstall preserves the module record');
    } finally {
      moduleLifecycle.disable = originalDisable;
    }

    const removed = packLifecycle.uninstall(PACK);
    assert.deepStrictEqual(removed.removed.modules, ['developer-tools']);
    assert.strictEqual(packRepository.getPack(PACK), null);
  });

  test('CP.19: failed third-party component removal restores pack metadata', () => {
    const fixture = path.resolve(__dirname, 'fixtures', 'third-party-pack');
    packLifecycle.install(fixture);
    copyTree(fixture, FIXTURE_UPGRADE_DIR);
    const manifestPath = path.join(FIXTURE_UPGRADE_DIR, 'sidekick.pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.version = '1.1.0';
    manifest.modules = [];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rmSync(path.join(FIXTURE_UPGRADE_DIR, 'modules'), { recursive: true, force: true });

    const before = packRepository.getPack('fixture-observatory');
    const originalUninstall = moduleLifecycle.uninstall;
    moduleLifecycle.uninstall = () => { throw new Error('simulated component removal failure'); };
    try {
      assert.throws(
        () => packLifecycle.upgrade('fixture-observatory', FIXTURE_UPGRADE_DIR),
        /simulated component removal failure/
      );
    } finally {
      moduleLifecycle.uninstall = originalUninstall;
    }

    const restored = packRepository.getPack('fixture-observatory');
    assert.strictEqual(restored.version, before.version);
    assert.strictEqual(restored.install_path, before.install_path);
    assert.strictEqual(restored.package_hash, before.package_hash);
    assert.ok(fs.existsSync(restored.install_path), 'rollback keeps the previous package installed');
    assert.ok(moduleRepository.getModule('observatory-tools'), 'owned module remains registered');
    assert.strictEqual(packRepository.listComponents('fixture-observatory').length, 1);

    packLifecycle.uninstall('fixture-observatory');
    fs.rmSync(FIXTURE_UPGRADE_DIR, { recursive: true, force: true });
  });

  console.log(`\n${failures === 0 ? 'All Capability Packs v1 tests passed.' : `${failures} capability-pack test(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
