const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-modules-repository');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

function freshRequire() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](db\.js|modules[\\/]|platform[\\/])/.test(key)) {
      delete require.cache[key];
    }
  }
  return {
    dbStore: require('../src/db'),
    repository: require('../src/modules/repository'),
    migrations: require('../src/modules/migrations'),
  };
}

let { dbStore, repository, migrations } = freshRequire();

const DEMO_MANIFEST = {
  name: 'demo-module',
  version: '1.2.0',
  description: 'Repository integration test module',
  type: 'plugin',
  configSchema: {
    type: 'object',
    properties: { retention_days: { type: 'number' } },
    required: ['retention_days'],
    additionalProperties: false,
  },
  migrations: [
    {
      name: 'seed-extension-row',
      sql: "INSERT INTO platform_extensions (extension_id, name, version, registered_at) VALUES ('ext_demo_seed', 'demo-module-meta', '1.0.0', '2026-08-10T00:00:00.000Z')",
    },
    {
      name: 'mark-seeded',
      sql: 'UPDATE platform_extensions SET metadata_json = \'{"seeded":true}\' WHERE extension_id = \'ext_demo_seed\'',
    },
  ],
};

const BROKEN_MANIFEST = {
  name: 'broken-module',
  version: '0.1.0',
  description: 'Module whose second migration fails',
  migrations: [
    {
      name: 'seed',
      sql: "INSERT INTO platform_extensions (extension_id, name, version, registered_at) VALUES ('ext_broken_seed', 'broken-module-meta', '0.1.0', '2026-08-10T00:00:00.000Z')",
    },
    {
      name: 'explode',
      sql: 'UPDATE platform_nonexistent_table SET x = 1',
    },
  ],
};

console.log('Running Module Repository Tests...\n');

(async () => {
  try {
    console.log('Test MR.1: existing migration mechanism provides platform_modules');
    dbStore.runPendingMigrations();
    let tables = dbStore.getTableList().map(t => t.name);
    assert.ok(tables.includes('platform_modules'), 'platform_modules should exist after migrations');
    repository.ensureModuleStorage();
    repository.ensureModuleStorage();
    tables = dbStore.getTableList().map(t => t.name);
    assert.strictEqual(tables.filter(t => t === 'platform_modules').length, 1, 'ensureModuleStorage should be idempotent');
    console.log('Passed\n');

    console.log('Test MR.2: first-time module persistence');
    const registered = repository.registerModule(DEMO_MANIFEST, { source: 'test', entryPoint: 'modules/demo/index.js' });
    assert.strictEqual(registered.state, 'validated', 'Registered module should start validated');
    assert.strictEqual(registered.version, '1.2.0', 'Version should persist');
    assert.strictEqual(registered.source, 'test', 'Source should persist');
    assert.strictEqual(registered.entry_point, 'modules/demo/index.js', 'Entry point should persist');
    assert.strictEqual(registered.manifest.name, 'demo-module', 'Manifest should round-trip');
    assert.strictEqual(registered.manifest.migrations.length, 2, 'Manifest migrations should round-trip');
    assert.strictEqual(registered.migration_version, 0, 'No migrations applied at registration');
    assert.deepStrictEqual(registered.applied_migrations, [], 'Applied migrations start empty');
    assert.throws(() => repository.registerModule(DEMO_MANIFEST), /already registered/, 'Duplicate registration should fail closed');
    assert.throws(
      () => repository.registerModule({ ...DEMO_MANIFEST, name: 'bad-config-module' }, { config: { retention_days: 'nope' } }),
      /config is invalid/,
      'Invalid config should fail registration'
    );
    console.log('Passed\n');

    console.log('Test MR.3: migration progress persists atomically with the lifecycle state');
    const installResult = repository.applyModuleMigrations('demo-module', { transitionTo: 'installed' });
    assert.deepStrictEqual(installResult.applied, ['seed-extension-row', 'mark-seeded'], 'Both migrations should apply in order');
    assert.strictEqual(installResult.module.state, 'installed', 'Module should transition with the migration batch');
    assert.ok(installResult.module.installed_at, 'installed_at should be stamped');
    assert.strictEqual(installResult.module.migration_version, 2, 'migration_version should equal applied count');
    assert.deepStrictEqual(installResult.module.applied_migrations, ['seed-extension-row', 'mark-seeded'], 'Progress should persist');
    const seeded = dbStore.getDb().prepare("SELECT metadata_json FROM platform_extensions WHERE extension_id = 'ext_demo_seed'").get();
    assert.ok(seeded, 'Migration data should be committed');
    assert.strictEqual(JSON.parse(seeded.metadata_json).seeded, true, 'Second migration should have run after the first');
    console.log('Passed\n');

    console.log('Test MR.4: lifecycle transitions validate, stamp timestamps and persist');
    assert.throws(
      () => repository.transitionModule('demo-module', 'configured', { config: { retention_days: 'bad' } }),
      /config is invalid/,
      'Invalid config should fail the transition'
    );
    assert.strictEqual(repository.getModule('demo-module').state, 'installed', 'Failed config transition should not change state');
    const configured = repository.transitionModule('demo-module', 'configured', { config: { retention_days: 30 } });
    assert.strictEqual(configured.state, 'configured', 'installed -> configured should be allowed');
    assert.ok(configured.configured_at, 'configured_at should be stamped');
    assert.deepStrictEqual(configured.config, { retention_days: 30 }, 'Validated config should persist with the transition');
    const enabled = repository.transitionModule('demo-module', 'enabled');
    assert.strictEqual(enabled.state, 'enabled', 'configured -> enabled should be allowed');
    assert.throws(() => repository.transitionModule('demo-module', 'installed'), /Invalid module transition/, 'enabled -> installed should be rejected');
    const errored = repository.transitionModule('demo-module', 'error', { error: 'health check failed' });
    assert.strictEqual(errored.state, 'error', 'enabled -> error should be allowed');
    assert.strictEqual(errored.error, 'health check failed', 'Error message should persist');
    assert.strictEqual(errored.error_count, 1, 'error_count should increment');
    const recovered = repository.transitionModule('demo-module', 'enabled');
    assert.strictEqual(recovered.state, 'enabled', 'error -> enabled recovery should be allowed');
    assert.strictEqual(recovered.error, null, 'Error should clear on recovery');
    assert.strictEqual(recovered.error_count, 1, 'error_count history should be retained');
    console.log('Passed\n');

    console.log('Test MR.5: atomic rollback when a migration in the batch fails');
    repository.registerModule(BROKEN_MANIFEST);
    assert.throws(
      () => repository.applyModuleMigrations('broken-module', { transitionTo: 'installed' }),
      /migration batch failed/,
      'Failing migration should abort the batch'
    );
    const brokenSeed = dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = 'ext_broken_seed'").get();
    assert.strictEqual(brokenSeed, undefined, 'Data from the earlier migration in the batch should roll back');
    const broken = repository.getModule('broken-module');
    assert.strictEqual(broken.state, 'validated', 'Lifecycle state should be unchanged after rollback');
    assert.strictEqual(broken.migration_version, 0, 'No progress should be recorded after rollback');
    assert.deepStrictEqual(broken.applied_migrations, [], 'Applied migrations should be unchanged after rollback');
    assert.throws(
      () => repository.applyModuleMigrations('broken-module', { transitionTo: 'healthy' }),
      /Invalid module transition/,
      'Invalid target state should fail before any migration runs'
    );
    assert.strictEqual(
      dbStore.getDb().prepare("SELECT COUNT(*) AS count FROM platform_extensions WHERE extension_id = 'ext_broken_seed'").get().count,
      0,
      'Fail-fast transition validation should not apply data changes'
    );
    console.log('Passed\n');

    console.log('Test MR.6: atomic rollback when progress persistence fails');
    assert.throws(
      () =>
        migrations.runModuleMigrations(
          dbStore.getDb(),
          'hook-module',
          [{ name: 'seed', sql: "INSERT INTO platform_extensions (extension_id, name, version, registered_at) VALUES ('ext_hook_seed', 'hook-module-meta', '1.0.0', '2026-08-10T00:00:00.000Z')" }],
          [],
          { recordProgress() { throw new Error('synthetic persistence failure'); } }
        ),
      /migration batch failed: synthetic persistence failure/,
      'Persistence hook failure should abort the batch'
    );
    const hookSeed = dbStore.getDb().prepare("SELECT * FROM platform_extensions WHERE extension_id = 'ext_hook_seed'").get();
    assert.strictEqual(hookSeed, undefined, 'Data migrations should roll back when progress persistence fails');
    console.log('Passed\n');

    console.log('Test MR.7: module state survives a repository/process restart');
    ({ dbStore, repository, migrations } = freshRequire());
    const reloaded = repository.getModule('demo-module');
    assert.ok(reloaded, 'Module should be present after restart');
    assert.strictEqual(reloaded.state, 'enabled', 'Lifecycle state should survive restart');
    assert.strictEqual(reloaded.migration_version, 2, 'Migration progress should survive restart');
    assert.deepStrictEqual(reloaded.applied_migrations, ['seed-extension-row', 'mark-seeded'], 'Applied migration names should survive restart');
    assert.deepStrictEqual(reloaded.config, { retention_days: 30 }, 'Config should survive restart');
    assert.strictEqual(reloaded.manifest.description, 'Repository integration test module', 'Manifest should survive restart');
    const states = repository.listModules({ state: 'validated' }).map(m => m.name);
    assert.deepStrictEqual(states, ['broken-module'], 'State-filtered listing should reflect persisted states');
    console.log('Passed\n');

    console.log('Test MR.8: completed migrations are never reapplied');
    const rerun = repository.applyModuleMigrations('demo-module');
    assert.deepStrictEqual(rerun.applied, [], 'No migrations should be reapplied after restart');
    assert.deepStrictEqual(rerun.alreadyApplied, ['seed-extension-row', 'mark-seeded'], 'Already-applied names should be reported');
    assert.strictEqual(rerun.module.migration_version, 2, 'migration_version should be unchanged');
    assert.strictEqual(
      dbStore.getDb().prepare("SELECT COUNT(*) AS count FROM platform_extensions WHERE extension_id = 'ext_demo_seed'").get().count,
      1,
      'Seed row should not be duplicated by a rerun'
    );
    console.log('Passed\n');

    console.log('All Module Repository tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Module Repository test failed:', error);
    process.exit(1);
  }
})();
