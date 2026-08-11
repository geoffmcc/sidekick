const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-modules-permissions');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'modules-permissions-test-secret-key';
delete process.env.SIDEKICK_BLOCKED_TOOLS;
delete process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS;
delete process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS;

const dbStore = require('../src/db');
const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const repository = require('../src/modules/repository');
const loader = require('../src/modules/loader');

const PERM_MANIFEST = {
  name: 'perm-module',
  version: '1.0.0',
  description: 'Permission enforcement test module',
  tools: { perm_probe: { risk: 'low', category: 'Test' } },
  permissions: [
    { tool: 'store', risk: 'low' },
    // Conflicting duplicates must resolve to the most restrictive cap (low),
    // so the bash dispatch in MP.2 stays denied despite the critical grant.
    { tool: 'bash', risk: 'critical' },
    { tool: 'bash', risk: 'low' },
    { tool: 'mod_low_tool', risk: 'low' },
  ],
};

const permEntry = {
  buildDescriptors(services) {
    return [
      {
        name: 'perm_probe',
        description: 'Dispatch a target tool through the module facade',
        schema: z.object({ target: z.string(), targetArgs: z.record(z.any()).optional() }),
        risk: 'low',
        category: 'Test',
        handler: async args => services.dispatch(args.target, args.targetArgs || {}),
      },
    ];
  },
};

const RISK_MANIFEST = {
  name: 'risk-module',
  version: '1.0.0',
  description: 'Risk parity test module',
  tools: {
    mod_low_tool: { risk: 'low', category: 'Test', aliases: ['mod_low_alias'] },
    mod_high_tool: { risk: 'high', category: 'Test' },
  },
};

const riskEntry = {
  buildDescriptors() {
    const make = (name, risk, aliases = []) => ({
      name,
      description: `${risk} risk module tool`,
      schema: z.object({}),
      risk,
      category: 'Test',
      aliases,
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    return [make('mod_low_tool', 'low', ['mod_low_alias']), make('mod_high_tool', 'high')];
  },
};

function installAndEnable(manifest, entry) {
  repository.registerModule(manifest, { source: 'test' });
  repository.applyModuleMigrations(manifest.name, { transitionTo: 'installed' });
  return loader.enableModule(manifest.name, entry);
}

console.log('Running Module Permission Tests...\n');

(async () => {
  try {
    dbStore.runPendingMigrations();
    installAndEnable(PERM_MANIFEST, permEntry);
    installAndEnable(RISK_MANIFEST, riskEntry);

    console.log('Test MP.1: facade dispatch denies undeclared tools by default');
    const undeclared = await tools.callInternalTool('perm_probe', { target: 'hash' });
    assert.ok(undeclared.isError, 'Undeclared tool dispatch should fail');
    assert.strictEqual(undeclared.code, 'module_permission_denied', 'Denial should use the module permission code');
    assert.ok(/no declared permission for tool "hash"/.test(undeclared.content[0].text), 'Denial should name the tool');
    console.log('Passed\n');

    console.log('Test MP.2: facade dispatch enforces the declared risk cap');
    const overCap = await tools.callInternalTool('perm_probe', { target: 'bash' });
    assert.ok(overCap.isError, 'Over-cap dispatch should fail');
    assert.strictEqual(overCap.code, 'module_permission_denied', 'Risk cap should use the module permission code');
    assert.ok(/caps risk at low but the tool resolves to critical/.test(overCap.content[0].text), 'Denial should state the risk mismatch');
    console.log('Passed\n');

    console.log('Test MP.3: permitted dispatch succeeds and is attributed to the module');
    const allowed = await tools.callInternalTool('perm_probe', { target: 'store', targetArgs: { key: 'perm_test_key', value: 'v1' } });
    assert.ok(!allowed.isError, `Permitted dispatch should succeed: ${JSON.stringify(allowed.content)}`);
    const childLog = dbStore.getDb()
      .prepare("SELECT entry_json FROM tool_logs WHERE tool_name = 'store' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(childLog, 'Child tool call should be logged');
    assert.strictEqual(JSON.parse(childLog.entry_json).module, 'perm-module', 'Child call should carry module attribution');
    const outerLog = dbStore.getDb()
      .prepare("SELECT entry_json FROM tool_logs WHERE tool_name = 'perm_probe' ORDER BY id DESC LIMIT 1")
      .get();
    assert.strictEqual(JSON.parse(outerLog.entry_json).module, null, 'Non-module-originated call should carry no module attribution');
    console.log('Passed\n');

    console.log('Test MP.4: risk lookup resolves active module tools to their declared risk');
    assert.strictEqual(legacy.getToolRisk('mod_low_tool'), 'low', 'Declared-low module tool should resolve low');
    assert.strictEqual(legacy.getToolRisk('mod_high_tool'), 'high', 'Declared-high module tool should resolve high');
    assert.strictEqual(legacy.getToolRisk('sidekick_mod_low_tool'), 'low', 'Prefixed lookup should resolve too');
    assert.strictEqual(legacy.getToolRisk('completely_unknown_tool'), 'critical', 'Unknown tools should stay critical');
    console.log('Passed\n');

    console.log('Test MP.5: strict-mode approval uses the declared module risk');
    process.env.SIDEKICK_APPROVAL_MODE = 'strict';
    try {
      const highDecision = legacy.getApprovalDecision('mod_high_tool', 'internal');
      assert.strictEqual(highDecision.required, true, 'Declared-high module tool should require approval in strict mode');
      assert.strictEqual(highDecision.risk, 'high', 'Enforced risk should equal declared risk');
      const lowDecision = legacy.getApprovalDecision('mod_low_tool', 'internal');
      assert.strictEqual(lowDecision.required, false, 'Declared-low module tool should not require approval in strict mode');
      assert.strictEqual(lowDecision.risk, 'low', 'Enforced risk should equal declared risk');
    } finally {
      process.env.SIDEKICK_APPROVAL_MODE = 'off';
    }
    console.log('Passed\n');

    console.log('Test MP.6: permission declared for a canonical tool covers its aliases');
    const viaAlias = await tools.callInternalTool('perm_probe', { target: 'mod_low_alias' });
    assert.ok(!viaAlias.isError, `Alias dispatch under a canonical permission should succeed: ${JSON.stringify(viaAlias.content)}`);
    assert.strictEqual(viaAlias.content[0].text, 'ok', 'Alias dispatch should reach the module tool');
    console.log('Passed\n');

    console.log('Test MP.7: risk lookup fails closed again once the module is disabled');
    loader.disableModule('risk-module');
    assert.strictEqual(legacy.getToolRisk('mod_low_tool'), 'critical', 'Disabled module tool should fall back to critical');
    console.log('Passed\n');

    console.log('All Module Permission tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Module Permission test failed:', error);
    process.exit(1);
  }
})();
