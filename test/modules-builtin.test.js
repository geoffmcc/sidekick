const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-modules-builtin');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'modules-builtin-test-secret-key';
delete process.env.SIDEKICK_BLOCKED_TOOLS;

function freshRequire() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](db\.js|tools-legacy\.js|modules[\\/]|tools[\\/])/.test(key)) {
      delete require.cache[key];
    }
  }
  return {
    dbStore: require('../src/db'),
    tools: require('../src/tools'),
    repository: require('../src/modules/repository'),
    loader: require('../src/modules/loader'),
    builtinModules: require('../src/modules/builtin-modules'),
  };
}

let { dbStore, tools, repository, loader, builtinModules } = freshRequire();

const DATA_UTILITY_TOOLS = ['parse', 'extract', 'transform', 'diff', 'validate', 'template'];

console.log('Running Builtin Module Provisioning Tests...\n');

(async () => {
  try {
    console.log('Test MB.1: first boot registers, installs and enables data-utilities');
    dbStore.runPendingMigrations();
    for (const name of DATA_UTILITY_TOOLS) {
      assert.strictEqual(tools.getBuiltinRegistry().get(name), undefined, `${name} should be absent before provisioning`);
    }
    const first = builtinModules.provisionBuiltinModules();
    assert.deepStrictEqual(first.errors, [], 'First provisioning should have no errors');
    assert.deepStrictEqual(first.provisioned, [{ name: 'data-utilities', action: 'registered' }], 'First boot should register the module');
    const record = repository.getModule('data-utilities');
    assert.strictEqual(record.state, 'enabled', 'Module should be enabled');
    assert.strictEqual(record.type, 'builtin', 'Module type should be builtin');
    assert.strictEqual(record.source, 'builtin', 'Module source should be builtin');
    for (const name of DATA_UTILITY_TOOLS) {
      const descriptor = tools.getBuiltinRegistry().get(name);
      assert.ok(descriptor, `${name} should resolve after provisioning`);
      assert.strictEqual(descriptor.source, 'module:data-utilities', `${name} should be module-owned`);
    }
    console.log('Passed\n');

    console.log('Test MB.2: module tools dispatch through the single dispatcher');
    const parsed = await tools.callInternalTool('parse', { input: '{"a":1}' });
    assert.ok(!parsed.isError, `parse should dispatch: ${JSON.stringify(parsed.content)}`);
    assert.deepStrictEqual(JSON.parse(parsed.content[0].text), { a: 1 }, 'parse should return parsed JSON');
    assert.strictEqual(require('../src/tools-legacy').getToolRisk('extract'), 'medium', 'Module tool risk should resolve to declared risk');
    console.log('Passed\n');

    console.log('Test MB.3: catalog sync exposes module tools without deprecating them');
    require('../src/tools-legacy').syncToolRegistry();
    const row = dbStore.getDb().prepare("SELECT risk, enabled, deprecated FROM tools WHERE name = 'parse'").get();
    assert.ok(row, 'parse should be in the tools catalog');
    assert.strictEqual(row.enabled, 1, 'parse should be enabled in the catalog');
    assert.strictEqual(row.deprecated, 0, 'parse should not be deprecated in the catalog');
    assert.strictEqual(row.risk, 'low', 'Catalog risk should match the module declaration');
    const uncategorized = dbStore.getDb().prepare(`
      SELECT t.name
      FROM tools t
      LEFT JOIN tool_category_map tcm ON tcm.tool_name = t.name
      WHERE t.enabled = 1 AND t.deprecated = 0
      GROUP BY t.name
      HAVING COUNT(tcm.category_id) = 0
      ORDER BY t.name
    `).all();
    assert.deepStrictEqual(uncategorized, [], 'every enabled non-deprecated tool must have a persisted category');
    for (const [toolName, category] of [['browser', 'Networking'], ['compute', 'Compute'], ['download', 'Media']]) {
      const mapped = dbStore.getDb().prepare(`
        SELECT tc.name
        FROM tools t
        JOIN tool_category_map tcm ON tcm.tool_name = t.name
        JOIN tool_categories tc ON tc.id = tcm.category_id
        WHERE t.name = ?
      `).get(toolName);
      assert.ok(mapped, `${toolName} should have a category mapping`);
      assert.strictEqual(mapped.name, category, `${toolName} category must remain ${category}`);
    }
    console.log('Passed\n');

    console.log('Test MB.4: restart restores the module without re-registering');
    const registeredAt = repository.getModule('data-utilities').registered_at;
    ({ dbStore, tools, repository, loader, builtinModules } = freshRequire());
    for (const name of DATA_UTILITY_TOOLS) {
      assert.strictEqual(tools.getBuiltinRegistry().get(name), undefined, `${name} should be absent before restore`);
    }
    const second = builtinModules.provisionBuiltinModules();
    assert.deepStrictEqual(second.errors, [], 'Restore provisioning should have no errors');
    assert.deepStrictEqual(second.provisioned, [{ name: 'data-utilities', action: 'restored' }], 'Restart should restore, not re-register');
    assert.strictEqual(repository.getModule('data-utilities').registered_at, registeredAt, 'Registration timestamp should be unchanged');
    assert.strictEqual(
      dbStore.getDb().prepare("SELECT COUNT(*) AS count FROM platform_modules WHERE name = 'data-utilities'").get().count,
      1,
      'Exactly one module row should exist after restart'
    );
    const uncategorizedAfterRestart = dbStore.getDb().prepare(`
      SELECT t.name
      FROM tools t
      LEFT JOIN tool_category_map tcm ON tcm.tool_name = t.name
      WHERE t.enabled = 1 AND t.deprecated = 0
      GROUP BY t.name
      HAVING COUNT(tcm.category_id) = 0
      ORDER BY t.name
    `).all();
    assert.deepStrictEqual(uncategorizedAfterRestart, [], 'restart sync must preserve complete category coverage');
    const reParsed = await tools.callInternalTool('template', { template: 'hi {{n}}', data: '{"n":"x"}' });
    assert.ok(!reParsed.isError, 'Module tools should dispatch after restore');
    assert.strictEqual(reParsed.content[0].text, 'hi x', 'template should render after restore');
    console.log('Passed\n');

    console.log('Test MB.5: provisioning never overrides operator intent');
    const disabledByTool = await tools.callInternalTool('module', { action: 'disable', name: 'data-utilities' });
    assert.ok(!disabledByTool.isError, 'Operator disable should dispatch through the module tool');
    assert.strictEqual(repository.getModule('data-utilities').state, 'disabled', 'Module should be disabled');
    const third = builtinModules.provisionBuiltinModules();
    assert.deepStrictEqual(third.provisioned, [], 'Disabled module should not be provisioned');
    assert.deepStrictEqual(third.skipped, [{ name: 'data-utilities', state: 'disabled' }], 'Disabled module should be reported as skipped');
    assert.strictEqual(tools.getBuiltinRegistry().get('parse'), undefined, 'Disabled module tools should not resolve');
    const disabledDispatch = await tools.callInternalTool('parse', { input: '{}' });
    assert.ok(disabledDispatch.isError, 'Disabled module tool should not dispatch');
    assert.strictEqual(disabledDispatch.code, 'unknown_tool', 'Disabled module tool should be unknown');
    console.log('Passed\n');

    console.log('Test MB.6: operator re-enable brings the tools back');
    const enabledByTool = await tools.callInternalTool('module', { action: 'enable', name: 'data-utilities' });
    assert.ok(!enabledByTool.isError, 'Operator enable should dispatch through the module tool');
    assert.strictEqual(repository.getModule('data-utilities').state, 'enabled', 'Module should be enabled again');
    const back = await tools.callInternalTool('validate', { data: '{"a":1}', schema: '{"type":"object"}' });
    assert.ok(!back.isError, 'Re-enabled module tool should dispatch');
    console.log('Passed\n');

    console.log('Test MB.7: a crash-stranded bootstrap state is resumed, not skipped forever');
    ({ dbStore, tools, repository, loader, builtinModules } = freshRequire());
    // Simulate a process that crashed between registration and enablement.
    dbStore.getDb().prepare("UPDATE platform_modules SET state = 'validated', enabled_at = NULL, installed_at = NULL WHERE name = 'data-utilities'").run();
    const resumed = builtinModules.provisionBuiltinModules();
    assert.deepStrictEqual(resumed.errors, [], 'Resumed provisioning should have no errors');
    assert.deepStrictEqual(resumed.provisioned, [{ name: 'data-utilities', action: 'registered' }], 'Stranded bootstrap should be resumed');
    assert.strictEqual(repository.getModule('data-utilities').state, 'enabled', 'Resumed module should reach enabled');
    const resumedDispatch = await tools.callInternalTool('parse', { input: '{"ok":true}' });
    assert.ok(!resumedDispatch.isError, 'Resumed module tools should dispatch');
    console.log('Passed\n');

    console.log('All Builtin Module Provisioning tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Builtin Module Provisioning test failed:', error);
    process.exit(1);
  }
})();
