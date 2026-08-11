const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-modules-observability');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'modules-observability-test-secret-key';
delete process.env.SIDEKICK_BLOCKED_TOOLS;

const dbStore = require('../src/db');
const tools = require('../src/tools');
const repository = require('../src/modules/repository');
const loader = require('../src/modules/loader');
const builtinModules = require('../src/modules/builtin-modules');

function events(type) {
  return dbStore.getDb()
    .prepare('SELECT payload_json FROM platform_execution_events WHERE event_type = ? ORDER BY rowid')
    .all(type)
    .map(r => JSON.parse(r.payload_json));
}

function setModuleState(state) {
  dbStore.getDb().prepare("UPDATE platform_modules SET state = ? WHERE name = 'data-utilities'").run(state);
}

console.log('Running Module Observability Tests...\n');

(async () => {
  try {
    console.log('Test MO.1: provisioning and lifecycle transitions emit kernel events');
    dbStore.runPendingMigrations();
    const outcome = builtinModules.provisionBuiltinModules();
    assert.deepStrictEqual(outcome.errors, [], 'Provisioning should succeed');
    const transitions = events('module.transition');
    assert.deepStrictEqual(
      transitions.map(t => `${t.from}->${t.to}`),
      ['validated->installed', 'installed->enabled'],
      'Bootstrap transitions should be recorded in the kernel ledger'
    );
    assert.strictEqual(transitions[0].module, 'data-utilities', 'Transition events should name the module');
    const provisioning = events('module.provisioning');
    assert.strictEqual(provisioning.length, 1, 'Provisioning run should be recorded');
    assert.deepStrictEqual(provisioning[0].provisioned, [{ name: 'data-utilities', action: 'registered' }], 'Provisioning payload should carry the outcome');
    console.log('Passed\n');

    console.log('Test MO.2: status tool exposes module state read-only');
    const status = await tools.callInternalTool('status', { include: 'modules' });
    assert.ok(!status.isError, `status should succeed: ${JSON.stringify(status.content)}`);
    const statusOut = JSON.parse(status.content[0].text);
    assert.strictEqual(statusOut.modules.length, 1, 'Status should list the module');
    assert.strictEqual(statusOut.modules[0].name, 'data-utilities', 'Status should name the module');
    assert.strictEqual(statusOut.modules[0].state, 'enabled', 'Status should report persisted state');
    assert.strictEqual(statusOut.modules[0].active_in_process, true, 'Status should report in-process activation');
    assert.ok(statusOut.modules[0].tools.includes('parse'), 'Status should list module tools');
    dbStore.getDb().prepare("UPDATE platform_modules SET state = 'enabled', health_json = '{}', last_health_check_at = NULL, error = NULL WHERE name = 'data-utilities'").run();
    const moduleHealth = await tools.callInternalTool('module', { action: 'health', name: 'data-utilities' });
    assert.ok(!moduleHealth.isError, 'module health report should succeed');
    const moduleHealthOut = JSON.parse(moduleHealth.content[0].text);
    assert.strictEqual(moduleHealthOut.module.name, 'data-utilities', 'Module health report should name the module');
    assert.deepStrictEqual(moduleHealthOut.module.health, {}, 'Module health report should expose the persisted health payload');
    assert.strictEqual(moduleHealthOut.module.last_health_check_at, null, 'Module health report should expose the missing check timestamp');
    console.log('Passed\n');

    console.log('Test MO.3: health check scores module state');
    const healthy = await tools.callInternalTool('health', { check: 'modules' });
    assert.ok(!healthy.isError, 'health should succeed');
    const healthyText = healthy.content[0].text;
    assert.ok(/## Modules/.test(healthyText), 'Health report should include a Modules section');
    assert.ok(/Overall Score: 100\/100/.test(healthyText), 'Healthy modules should score 100');
    assert.ok(/data-utilities: enabled \(active\)/.test(healthyText), 'Health should show the module active');
    assert.ok(!/## Issues/.test(healthyText), 'Healthy modules should raise no issues');
    const checked = await tools.callInternalTool('module', { action: 'check', name: 'data-utilities' });
    assert.ok(!checked.isError, 'module health check should succeed');
    const checkedOut = JSON.parse(checked.content[0].text);
    assert.strictEqual(checkedOut.result.ok, true, 'Module health check should report success');
    assert.strictEqual(checkedOut.result.module.state, 'healthy', 'Successful health check should transition the module to healthy');
    assert.strictEqual(events('module.health.check').length, 1, 'Health checks should be recorded in the kernel ledger');
    assert.strictEqual(events('module.health.check')[0].ok, true, 'Health event should record the check result');
    const healthReport = JSON.parse((await tools.callInternalTool('module', { action: 'health', name: 'data-utilities' })).content[0].text);
    assert.strictEqual(healthReport.module.health_history.length, 1, 'Health report should expose recent check history');
    assert.strictEqual(healthReport.module.health_history[0].state, 'healthy', 'History should capture the resulting module state');
    console.log('Passed\n');

    console.log('Test MO.4: a disable in another process stops dispatch here immediately');
    assert.ok(!(await tools.callInternalTool('parse', { input: '{}' })).isError, 'parse should dispatch while enabled');
    setModuleState('disabled');
    assert.strictEqual(loader.isModuleActive('data-utilities'), true, 'Local registration is stale before the gated dispatch');
    const gated = await tools.callInternalTool('parse', { input: '{}' });
    assert.ok(gated.isError, 'Dispatch should fail once the persisted state is disabled');
    assert.strictEqual(gated.code, 'module_disabled', 'Gate should use the module_disabled code');
    assert.strictEqual(loader.isModuleActive('data-utilities'), false, 'Gate should self-heal the stale local registration');
    assert.strictEqual(tools.getBuiltinRegistry().get('parse'), undefined, 'Registry should drop the deactivated module tools');
    console.log('Passed\n');

    console.log('Test MO.5: health flags an enabled module that is not active in this process');
    setModuleState('enabled');
    const skewed = await tools.callInternalTool('health', { check: 'modules' });
    const skewedText = skewed.content[0].text;
    assert.ok(!/Overall Score: 100\/100/.test(skewedText), 'Enabled-but-inactive should reduce the score');
    assert.ok(/not active in this process/.test(skewedText), 'Health should name the inactive module condition');
    console.log('Passed\n');

    console.log('Test MO.6: reconciliation converges a re-enable without a restart');
    const reconciled = loader.reconcilePersistedModules(builtinModules.builtinEntriesByName());
    assert.deepStrictEqual(reconciled.activated, ['data-utilities'], 'Reconciliation should re-activate the module');
    assert.deepStrictEqual(reconciled.failed, [], 'Reconciliation should not fail');
    const restored = await tools.callInternalTool('parse', { input: '{"back":true}' });
    assert.ok(!restored.isError, 'Dispatch should work after reconciliation');
    const errored = events('module.transition').filter(t => t.to === 'error');
    assert.strictEqual(errored.length, 0, 'No error transitions should have been recorded in this flow');
    console.log('Passed\n');

    console.log('Test MO.7: health reports an error-state module with its message');
    dbStore.getDb().prepare("UPDATE platform_modules SET state = 'error', error = 'synthetic fault' WHERE name = 'data-utilities'").run();
    const faulted = await tools.callInternalTool('health', { check: 'modules' });
    assert.ok(/error state: synthetic fault/.test(faulted.content[0].text), 'Health should surface the module error');
    const recovered = await tools.callInternalTool('module', { action: 'recover', name: 'data-utilities' });
    assert.ok(!recovered.isError, 'Module recovery should succeed');
    const recoveredOut = JSON.parse(recovered.content[0].text);
    assert.strictEqual(recoveredOut.result.ok, true, 'Recovery should require a passing health check');
    assert.strictEqual(recoveredOut.result.module.state, 'healthy', 'Recovery should leave the module healthy');
    const sweep = builtinModules.runBuiltinModuleHealthChecks();
    assert.strictEqual(sweep.errors.length, 0, 'Scheduled health sweep should not report errors');
    assert.strictEqual(sweep.checked.length, 1, 'Scheduled health sweep should check the builtin module');
    assert.deepStrictEqual(sweep.alerts, [], 'Healthy sweep should not emit alerts');
    console.log('Passed\n');

    console.log('Test MO.8: the dispatch gate fails closed when the state read throws');
    const realGetModule = repository.getModule;
    repository.getModule = () => { throw new Error('synthetic db failure'); };
    try {
      const gateFailure = await tools.callInternalTool('parse', { input: '{}' });
      assert.ok(gateFailure.isError, 'Dispatch must fail when the module state cannot be read');
      assert.ok(!/"ok"/.test(gateFailure.content[0].text || ''), 'Handler must not execute when the gate cannot verify state');
    } finally {
      repository.getModule = realGetModule;
    }
    assert.ok(!(await tools.callInternalTool('parse', { input: '{}' })).isError, 'Dispatch should recover once the state read works again');
    console.log('Passed\n');

    console.log('All Module Observability tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Module Observability test failed:', error);
    process.exit(1);
  }
})();
