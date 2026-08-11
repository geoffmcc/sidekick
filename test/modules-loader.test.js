const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-modules-loader');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'modules-loader-test-secret-key';
delete process.env.SIDEKICK_BLOCKED_TOOLS;
delete process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS;

function freshRequire() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](db\.js|modules[\\/]|tools[\\/](index\.js|registry\.js|dispatcher\.js))/.test(key)) {
      delete require.cache[key];
    }
  }
  return {
    dbStore: require('../src/db'),
    tools: require('../src/tools'),
    repository: require('../src/modules/repository'),
    loader: require('../src/modules/loader'),
  };
}

let { dbStore, tools, repository, loader } = freshRequire();

const DEMO_MANIFEST = {
  name: 'demo-loader-module',
  version: '1.0.0',
  description: 'Loader integration test module',
  tools: {
    demo_echo: { risk: 'low', category: 'Test', aliases: ['demo_echo_alias'] },
  },
};

let capturedServices = null;
const demoEntry = {
  buildDescriptors(services) {
    capturedServices = services;
    return [
      {
        name: 'demo_echo',
        description: 'Echo input back through a module handler',
        schema: z.object({ text: z.string() }),
        risk: 'low',
        category: 'Test',
        aliases: ['demo_echo_alias'],
        handler: async args => ({ content: [{ type: 'text', text: `${services.moduleName}:${args.text}` }] }),
      },
    ];
  },
};

console.log('Running Module Loader Tests...\n');

(async () => {
  try {
    console.log('Test ML.1: enableModule registers tools into the single builtin registry');
    dbStore.runPendingMigrations();
    repository.registerModule(DEMO_MANIFEST, { source: 'test' });
    repository.applyModuleMigrations('demo-loader-module', { transitionTo: 'installed' });
    assert.strictEqual(tools.getBuiltinRegistry().get('demo_echo'), undefined, 'Module tool should not resolve before activation');
    const enabled = loader.enableModule('demo-loader-module', demoEntry);
    assert.strictEqual(enabled.module.state, 'enabled', 'Module should transition to enabled');
    assert.ok(enabled.module.enabled_at, 'enabled_at should be stamped');
    const descriptor = tools.getBuiltinRegistry().get('demo_echo');
    assert.ok(descriptor, 'Module tool should resolve through the builtin registry');
    assert.strictEqual(descriptor.source, 'module:demo-loader-module', 'Descriptor source should identify the module');
    assert.strictEqual(tools.getBuiltinRegistry().get('demo_echo_alias').name, 'demo_echo', 'Module alias should resolve to the tool');
    const again = loader.enableModule('demo-loader-module', demoEntry);
    assert.strictEqual(again.alreadyActive, true, 'Re-enabling an active module should be a no-op');
    console.log('Passed\n');

    console.log('Test ML.2: module tool dispatches through the existing dispatcher');
    const result = await tools.callInternalTool('demo_echo', { text: 'hi' });
    assert.ok(!result.isError, `Dispatch should succeed: ${JSON.stringify(result.content)}`);
    assert.strictEqual(result.content[0].text, 'demo-loader-module:hi', 'Handler should run with the module facade');
    const invalid = await tools.callInternalTool('demo_echo', { text: 42 });
    assert.ok(invalid.isError, 'Schema validation should reject bad arguments');
    assert.strictEqual(invalid.code, 'validation_failed', 'Validation errors should use the dispatcher validation path');
    console.log('Passed\n');

    console.log('Test ML.3: handlers receive only the narrow frozen v1 facade');
    assert.ok(capturedServices, 'Entry should have been built with services');
    assert.deepStrictEqual(Object.keys(capturedServices).sort(), ['config', 'dispatch', 'moduleName'], 'v1 facade keys should be narrow');
    assert.ok(Object.isFrozen(capturedServices) && Object.isFrozen(capturedServices.config), 'Facade and config should be frozen');
    assert.strictEqual(capturedServices.moduleName, 'demo-loader-module', 'Facade should carry the module name');
    console.log('Passed\n');

    console.log('Test ML.4: ownership conflict with an existing tool fails closed to error state');
    repository.registerModule({
      name: 'conflicting-module',
      version: '1.0.0',
      description: 'Module that claims an existing builtin tool',
      tools: { status: { risk: 'low', category: 'Test' } },
    });
    repository.applyModuleMigrations('conflicting-module', { transitionTo: 'installed' });
    assert.throws(
      () =>
        loader.enableModule('conflicting-module', {
          buildDescriptors: () => [
            {
              name: 'status',
              description: 'Conflicting status tool',
              schema: z.object({}),
              risk: 'low',
              category: 'Test',
              handler: async () => ({ content: [] }),
            },
          ],
        }),
      /ownership check failed/,
      'Conflict with a builtin tool should be rejected'
    );
    const conflicting = repository.getModule('conflicting-module');
    assert.strictEqual(conflicting.state, 'error', 'Conflicting module should be in error state');
    assert.ok(/conflicts with an existing registered tool/.test(conflicting.error), 'Conflict should be recorded on the module');
    assert.strictEqual(loader.isModuleActive('conflicting-module'), false, 'Conflicting module should not be active');
    assert.notStrictEqual(tools.getBuiltinRegistry().get('status').source, 'module:conflicting-module', 'Builtin tool should keep its owner');
    console.log('Passed\n');

    console.log('Test ML.5: descriptor/manifest divergence fails closed to error state');
    repository.registerModule({
      name: 'mismatch-module',
      version: '1.0.0',
      description: 'Module whose descriptor risk diverges from its manifest',
      tools: { mismatch_tool: { risk: 'low', category: 'Test' } },
    });
    repository.applyModuleMigrations('mismatch-module', { transitionTo: 'installed' });
    assert.throws(
      () =>
        loader.enableModule('mismatch-module', {
          buildDescriptors: () => [
            {
              name: 'mismatch_tool',
              description: 'Mismatched risk tool',
              schema: z.object({}),
              risk: 'high',
              category: 'Test',
              handler: async () => ({ content: [] }),
            },
          ],
        }),
      /tool verification failed/,
      'Descriptor risk mismatch should be rejected'
    );
    const mismatch = repository.getModule('mismatch-module');
    assert.strictEqual(mismatch.state, 'error', 'Mismatched module should be in error state');
    assert.strictEqual(tools.getBuiltinRegistry().get('mismatch_tool'), undefined, 'Mismatched tool should not be registered');
    console.log('Passed\n');

    console.log('Test ML.6: disableModule removes registrations and persists the transition');
    const realTransition = repository.transitionModule;
    repository.transitionModule = () => { throw new Error('synthetic persistence failure'); };
    try {
      assert.throws(() => loader.disableModule('demo-loader-module'), /synthetic persistence failure/, 'Persistence failure should surface');
    } finally {
      repository.transitionModule = realTransition;
    }
    assert.strictEqual(loader.isModuleActive('demo-loader-module'), true, 'Module should stay active when the disable transition fails to persist');
    assert.strictEqual(repository.getModule('demo-loader-module').state, 'enabled', 'Persisted state should stay enabled when the transition fails');
    const disabled = loader.disableModule('demo-loader-module');
    assert.strictEqual(disabled.module.state, 'disabled', 'Module should transition to disabled');
    assert.ok(disabled.module.disabled_at, 'disabled_at should be stamped');
    assert.strictEqual(tools.getBuiltinRegistry().get('demo_echo'), undefined, 'Disabled module tool should not resolve');
    const afterDisable = await tools.callInternalTool('demo_echo', { text: 'hi' });
    assert.ok(afterDisable.isError, 'Dispatching a disabled module tool should fail');
    assert.strictEqual(afterDisable.code, 'unknown_tool', 'Disabled module tool should be unknown to the dispatcher');
    console.log('Passed\n');

    console.log('Test ML.7: persisted enabled modules are restored after a process restart');
    const reEnabled = loader.enableModule('demo-loader-module', demoEntry);
    assert.strictEqual(reEnabled.module.state, 'enabled', 'disabled -> enabled should be allowed');
    repository.registerModule({ name: 'orphan-module', version: '1.0.0', description: 'Enabled module with no startup entry' });
    repository.applyModuleMigrations('orphan-module', { transitionTo: 'installed' });
    loader.enableModule('orphan-module', { buildDescriptors: () => [] });
    assert.strictEqual(repository.getModule('orphan-module').state, 'enabled', 'Orphan module should be enabled before restart');

    ({ dbStore, tools, repository, loader } = freshRequire());
    assert.strictEqual(repository.getModule('demo-loader-module').state, 'enabled', 'Enabled state should survive restart');
    assert.strictEqual(tools.getBuiltinRegistry().get('demo_echo'), undefined, 'Module tools should not be live before restore');
    const restore = loader.restorePersistedModules({ 'demo-loader-module': demoEntry });
    assert.deepStrictEqual(restore.restored, ['demo-loader-module'], 'Persisted enabled module should be restored');
    assert.deepStrictEqual(restore.failed.map(f => f.name), ['orphan-module'], 'Enabled module without an entry should fail restore');
    assert.strictEqual(repository.getModule('orphan-module').state, 'enabled', 'A missing entry is process-local: persisted state must NOT be error-stated');
    assert.strictEqual(loader.isModuleActive('orphan-module'), false, 'Module without an entry should stay inactive in this process');
    assert.strictEqual(repository.getModule('demo-loader-module').state, 'enabled', 'Restore should not re-transition an enabled module');
    const restored = await tools.callInternalTool('demo_echo', { text: 'back' });
    assert.ok(!restored.isError, `Restored dispatch should succeed: ${JSON.stringify(restored.content)}`);
    assert.strictEqual(restored.content[0].text, 'demo-loader-module:back', 'Restored module tool should dispatch');
    console.log('Passed\n');

    console.log('Test ML.8: collision with a generated (dynamic) tool name fails closed');
    dbStore.saveGeneratedCapability({
      id: 'cap_loader_test_1',
      name: 'gen_collide_tool',
      state: 'trial',
      title: 'Generated collision target',
      description: 'Generated capability used to test module name collisions',
      risk: 'low',
    });
    repository.registerModule({
      name: 'generated-collision-module',
      version: '1.0.0',
      description: 'Module that claims a generated tool name',
      tools: { gen_collide_tool: { risk: 'low', category: 'Test' } },
    });
    repository.applyModuleMigrations('generated-collision-module', { transitionTo: 'installed' });
    assert.throws(
      () =>
        loader.enableModule('generated-collision-module', {
          buildDescriptors: () => [
            {
              name: 'gen_collide_tool',
              description: 'Shadowing tool',
              schema: z.object({}),
              risk: 'low',
              category: 'Test',
              handler: async () => ({ content: [] }),
            },
          ],
        }),
      /ownership check failed/,
      'Collision with a generated capability name should be rejected'
    );
    assert.strictEqual(repository.getModule('generated-collision-module').state, 'error', 'Colliding module should be in error state');
    assert.strictEqual(loader.isModuleActive('generated-collision-module'), false, 'Colliding module should not be active');
    console.log('Passed\n');

    console.log('All Module Loader tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Module Loader test failed:', error);
    process.exit(1);
  }
})();
