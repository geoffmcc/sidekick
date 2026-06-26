const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-approval-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = '';
process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = '';
process.env.SIDEKICK_APPROVAL_TTL_SECONDS = '3600';
process.env.SIDEKICK_SECRET_KEY = 'approval-test-secret-key';

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];
const tools = require('../src/tools');
const db = require('../src/db');

console.log('Running Approval Tests...\n');

(async () => {
  try {
    tools.setSource('mcp');

    console.log('Test 1: approval mode off preserves immediate execution');
    let result = await tools.callTool('sidekick_respond', { text: 'hello' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'hello');
    assert.strictEqual(tools.listApprovals().length, 0);
    console.log('Passed\n');

    console.log('Test 2: required tool queues approval');
    process.env.SIDEKICK_APPROVAL_MODE = 'risky';
    process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = 'sidekick_respond';
    result = await tools.callTool('sidekick_respond', {
      text: 'queued',
      password: 'short-secret',
      nested: { authorization: 'Bearer visible-looking-value' }
    });
    assert.ok(result.isError);
    assert.ok(result.approvalRequired);
    assert.ok(result.approvalId);
    let approvals = tools.listApprovals({ status: 'pending' });
    assert.strictEqual(approvals.length, 1);
    assert.strictEqual(approvals[0].tool, 'sidekick_respond');
    assert.ok(!Object.prototype.hasOwnProperty.call(approvals[0], 'args'));
    assert.ok(!Object.prototype.hasOwnProperty.call(approvals[0], 'args_encrypted'));
    assert.ok(!approvals[0].args_preview.includes('short-secret'));
    assert.ok(!approvals[0].args_preview.includes('visible-looking-value'));
    const storedApproval = db.loadDocument('approvals', [])[0];
    assert.ok(storedApproval.args_encrypted);
    assert.ok(!Object.prototype.hasOwnProperty.call(storedApproval, 'args'));
    assert.ok(!JSON.stringify(storedApproval).includes('short-secret'));
    console.log('Passed\n');

    console.log('Test 3: approving a queued request executes it');
    result = await tools.resolveApproval(approvals[0].id, 'approve', 'test');
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'queued');
    approvals = tools.listApprovals({ status: 'approved' });
    assert.strictEqual(approvals.length, 1);
    const completedApproval = db.loadDocument('approvals', [])[0];
    assert.ok(!Object.prototype.hasOwnProperty.call(completedApproval, 'args_encrypted'));
    console.log('Passed\n');

    console.log('Test 4: exempt tool bypasses approval');
    process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = 'sidekick_respond';
    result = await tools.callTool('sidekick_respond', { text: 'exempt' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'exempt');
    assert.strictEqual(tools.listApprovals({ status: 'pending' }).length, 0);
    console.log('Passed\n');

    console.log('Test 5: current policy is enforced when an approval runs');
    process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = '';
    result = await tools.callTool('sidekick_respond', { text: 'must stay blocked' });
    const blockedApprovalId = result.approvalId;
    process.env.SIDEKICK_BLOCKED_TOOLS = 'sidekick_respond';
    result = await tools.resolveApproval(blockedApprovalId, 'approve', 'test');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Tool blocked by policy'));
    assert.strictEqual(tools.listApprovals({ status: 'failed' }).length, 1);
    process.env.SIDEKICK_BLOCKED_TOOLS = '';
    console.log('Passed\n');

    console.log('Test 6: expired approvals cannot execute and discard payloads');
    result = await tools.callTool('sidekick_respond', { text: 'expired request' });
    const expiredApprovalId = result.approvalId;
    const storedApprovals = db.loadDocument('approvals', []);
    const expiring = storedApprovals.find(item => item.id === expiredApprovalId);
    expiring.expires_at = new Date(Date.now() - 1000).toISOString();
    db.setDocument('approvals', storedApprovals);
    assert.strictEqual(tools.listApprovals({ status: 'expired' }).length, 1);
    const expiredStored = db.loadDocument('approvals', []).find(item => item.id === expiredApprovalId);
    assert.ok(!Object.prototype.hasOwnProperty.call(expiredStored, 'args_encrypted'));
    result = await tools.resolveApproval(expiredApprovalId, 'approve', 'test');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already expired'));
    console.log('Passed\n');

    console.log('Test 7: missing encryption key fails closed');
    delete process.env.SIDEKICK_SECRET_KEY;
    result = await tools.callTool('sidekick_respond', { text: 'do not persist' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Approval queue unavailable'));
    assert.strictEqual(tools.listApprovals({ status: 'pending' }).length, 0);
    console.log('Passed\n');

    console.log('Test 8: legacy plaintext pending payloads are encrypted on access');
    process.env.SIDEKICK_SECRET_KEY = 'approval-test-secret-key';
    const legacyApprovals = db.loadDocument('approvals', []);
    legacyApprovals.unshift({
      id: 'approval_legacy_test',
      status: 'pending',
      tool: 'sidekick_respond',
      risk: 'low',
      source: 'mcp',
      mode: 'risky',
      reason: 'legacy test',
      args: { text: 'legacy queued', password: 'legacy-secret' },
      args_preview: '{ "password": "[REDACTED]" }',
      requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    db.setDocument('approvals', legacyApprovals);
    assert.strictEqual(tools.listApprovals({ status: 'pending' }).length, 1);
    const migratedLegacy = db.loadDocument('approvals', []).find(item => item.id === 'approval_legacy_test');
    assert.ok(migratedLegacy.args_encrypted);
    assert.ok(!Object.prototype.hasOwnProperty.call(migratedLegacy, 'args'));
    result = await tools.resolveApproval('approval_legacy_test', 'approve', 'test');
    assert.strictEqual(result.content[0].text, 'legacy queued');
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Approval Tests Passed!');
  } catch (e) {
    console.error('Approval test failed:', e);
    process.exit(1);
  }
})();
