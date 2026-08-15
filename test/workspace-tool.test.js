const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-workspace-tool-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_SECRET_KEY = 'workspace-tool-test-key';

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];
const tools = require('../src/tools');
const db = require('../src/db');
const platformKernel = require('../src/platform/kernel');
const { createTestExecutionContext, runWithContext } = require('../src/tools/context');

const { TOOLS } = tools;

console.log('Running Workspace Tool Tests...\n');

(async () => {
  try {
    tools.setSource('mcp');

    console.log('Test WT.1: the workspace tool is registered in the builtin registry with high risk');
    const registry = tools.getBuiltinRegistry();
    const descriptor = registry.get('workspace');
    assert.ok(descriptor, 'workspace descriptor registered');
    assert.strictEqual(descriptor.risk, 'high');
    assert.strictEqual(descriptor.category, 'Storage');
    assert.strictEqual(descriptor.family, 'workspace');
    assert.ok(tools.TOOL_DEFS.some(d => d.name === 'workspace'), 'workspace has a TOOL_DEFS anchor row');
    console.log('Passed\n');

    console.log('Test WT.2: create canonicalizes the project id and get resolves by workspace or project');
    let result = await TOOLS.workspace({ action: 'create', project: 'Ws-Tool-Test', config: { language: 'en' } });
    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const created = JSON.parse(result.content[0].text);
    assert.strictEqual(created.project_id, 'ws_tool_test');
    assert.ok(created.workspace_id);
    result = await TOOLS.workspace({ action: 'get', workspace_id: created.workspace_id });
    assert.strictEqual(JSON.parse(result.content[0].text).workspace_id, created.workspace_id);
    result = await TOOLS.workspace({ action: 'get', project: 'WS_TOOL_TEST' });
    assert.strictEqual(JSON.parse(result.content[0].text).workspace_id, created.workspace_id);
    result = await TOOLS.workspace({ action: 'get' });
    assert.strictEqual(result.isError, true);
    console.log('Passed\n');

    console.log('Test WT.3: list returns workspaces and filters by project');
    await TOOLS.workspace({ action: 'create', project: 'ws_tool_other' });
    const other = platformKernel.getWorkspaceByProject('ws_tool_other');
    result = await runWithContext(createTestExecutionContext({ project: 'ws_tool_test' }), () => TOOLS.workspace({ action: 'get', project: 'ws_tool_other' }));
    assert.ok(result.isError, 'execution project must not read another project workspace');
    result = await runWithContext(createTestExecutionContext({ project: 'ws_tool_test' }), () => TOOLS.workspace({ action: 'get', workspace_id: other.workspace_id }));
    assert.ok(result.isError, 'execution project must not read another workspace by id');
    result = await TOOLS.workspace({ action: 'list' });
    let listing = JSON.parse(result.content[0].text);
    assert.ok(listing.count >= 2);
    result = await TOOLS.workspace({ action: 'list', project: 'ws_tool_other' });
    listing = JSON.parse(result.content[0].text);
    assert.strictEqual(listing.count, 1);
    assert.strictEqual(listing.workspaces[0].project_id, 'ws_tool_other');
    console.log('Passed\n');

    console.log('Test WT.4: set_secret stores encrypted and every read exposes NAMES only, never values');
    result = await TOOLS.workspace({ action: 'set_secret', workspace_id: created.workspace_id, secret_name: 'api_key', secret_value: 'super-secret-value-42' });
    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    let out = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(out.secret_names, ['api_key']);
    assert.ok(!result.content[0].text.includes('super-secret-value-42'), 'set_secret output must not echo the value');
    for (const read of [
      await TOOLS.workspace({ action: 'get', workspace_id: created.workspace_id }),
      await TOOLS.workspace({ action: 'list', project: 'ws_tool_test' }),
    ]) {
      const text = read.content[0].text;
      assert.ok(text.includes('api_key'), 'secret NAME is listed');
      assert.ok(!text.includes('super-secret-value-42'), 'secret VALUE is never exposed');
      assert.ok(!text.includes('envelope'), 'no envelope material is exposed');
      assert.ok(!text.includes('secrets_json'), 'raw secrets_json never leaves the kernel');
    }
    // The value is stored encrypted at rest, not plaintext.
    const envelopeRow = db.getDb().prepare('SELECT envelope_json FROM platform_workspace_secrets WHERE workspace_id = ? AND secret_name = ?').get(created.workspace_id, 'api_key');
    assert.ok(envelopeRow);
    assert.ok(!envelopeRow.envelope_json.includes('super-secret-value-42'));
    console.log('Passed\n');

    console.log('Test WT.5: delete_secret removes the name; deleting a missing secret errors');
    result = await TOOLS.workspace({ action: 'delete_secret', workspace_id: created.workspace_id, secret_name: 'api_key' });
    assert.strictEqual(result.isError, undefined);
    result = await TOOLS.workspace({ action: 'get', workspace_id: created.workspace_id });
    assert.deepStrictEqual(JSON.parse(result.content[0].text).secret_names, []);
    result = await TOOLS.workspace({ action: 'delete_secret', workspace_id: created.workspace_id, secret_name: 'api_key' });
    assert.strictEqual(result.isError, true);
    console.log('Passed\n');

    console.log('Test WT.6: update changes config without touching secrets');
    result = await TOOLS.workspace({ action: 'update', workspace_id: created.workspace_id, config: { language: 'de', extra: true } });
    assert.strictEqual(result.isError, undefined);
    assert.deepStrictEqual(JSON.parse(result.content[0].text).config, { language: 'de', extra: true });
    console.log('Passed\n');

    console.log('Test WT.7: secret writes fail closed without SIDEKICK_SECRET_KEY and surface the kernel error');
    const prevKey = process.env.SIDEKICK_SECRET_KEY;
    delete process.env.SIDEKICK_SECRET_KEY;
    try {
      result = await TOOLS.workspace({ action: 'set_secret', workspace_id: created.workspace_id, secret_name: 'blocked', secret_value: 'nope' });
      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('SIDEKICK_SECRET_KEY'), 'the kernel fail-closed error is surfaced honestly');
      result = await TOOLS.workspace({ action: 'backfill_secrets', dry_run: false, confirm: true });
      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('SIDEKICK_SECRET_KEY'));
    } finally {
      process.env.SIDEKICK_SECRET_KEY = prevKey;
    }
    assert.strictEqual(db.getDb().prepare('SELECT COUNT(*) AS c FROM platform_workspace_secrets WHERE workspace_id = ? AND secret_name = ?').get(created.workspace_id, 'blocked').c, 0);
    console.log('Passed\n');

    console.log('Test WT.8: backfill_secrets defaults to a dry run that writes nothing');
    // Seed a legacy plaintext row the way pre-envelope code left them.
    const legacyWs = platformKernel.createProjectWorkspace({ name: 'legacy_ws', project_id: 'ws_tool_legacy' });
    db.getDb().prepare("UPDATE platform_project_workspaces SET secrets_json = ? WHERE workspace_id = ?").run(JSON.stringify({ legacy_token: 'legacy-plain-value' }), legacyWs.workspace_id);
    result = await TOOLS.workspace({ action: 'backfill_secrets' });
    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    assert.ok(result.content[0].text.includes('Dry run'));
    const dryReport = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('{')));
    assert.strictEqual(dryReport.dry_run, true);
    assert.strictEqual(dryReport.secrets_migrated, 1);
    assert.strictEqual(db.getDb().prepare('SELECT COUNT(*) AS c FROM platform_workspace_secrets WHERE workspace_id = ?').get(legacyWs.workspace_id).c, 0, 'dry run wrote no envelopes');
    assert.ok(db.getDb().prepare('SELECT secrets_json FROM platform_project_workspaces WHERE workspace_id = ?').get(legacyWs.workspace_id).secrets_json.includes('legacy-plain-value'), 'dry run cleared no plaintext');
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_execution_events WHERE event_type = 'workspace.secrets_backfilled'").get().c, 0, 'dry run appended no event');
    console.log('Passed\n');

    console.log('Test WT.9: real backfill_secrets requires confirm:true');
    result = await TOOLS.workspace({ action: 'backfill_secrets', dry_run: false });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('confirm:true'));
    assert.strictEqual(db.getDb().prepare('SELECT COUNT(*) AS c FROM platform_workspace_secrets WHERE workspace_id = ?').get(legacyWs.workspace_id).c, 0);
    console.log('Passed\n');

    console.log('Test WT.10: confirmed backfill_secrets migrates plaintext into envelopes and clears it');
    result = await TOOLS.workspace({ action: 'backfill_secrets', dry_run: false, confirm: true });
    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    assert.ok(result.content[0].text.includes('Secrets backfill complete'));
    const realReport = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('{')));
    assert.strictEqual(realReport.dry_run, false);
    assert.strictEqual(realReport.secrets_migrated, dryReport.secrets_migrated);
    assert.strictEqual(db.getDb().prepare('SELECT COUNT(*) AS c FROM platform_workspace_secrets WHERE workspace_id = ?').get(legacyWs.workspace_id).c, 1);
    assert.strictEqual(db.getDb().prepare('SELECT secrets_json FROM platform_project_workspaces WHERE workspace_id = ?').get(legacyWs.workspace_id).secrets_json, '{}', 'plaintext cleared after envelopes exist');
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_execution_events WHERE event_type = 'workspace.secrets_backfilled'").get().c, 1);
    console.log('Passed\n');

    console.log('Test WT.11: unknown action fails closed; dispatcher path rejects coerced gates');
    result = await TOOLS.workspace({ action: 'destroy_everything' });
    assert.strictEqual(result.isError, true);
    result = await tools.callTool('workspace', { action: 'backfill_secrets', dry_run: 'false', confirm: true });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('Invalid arguments'));
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Workspace Tool Tests Passed!');
  } catch (e) {
    console.error('Workspace tool test failed:', e);
    process.exit(1);
  }
})();
