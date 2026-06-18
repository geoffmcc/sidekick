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

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];
const tools = require('../src/tools');

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
    result = await tools.callTool('sidekick_respond', { text: 'queued' });
    assert.ok(result.isError);
    assert.ok(result.approvalRequired);
    assert.ok(result.approvalId);
    let approvals = tools.listApprovals({ status: 'pending' });
    assert.strictEqual(approvals.length, 1);
    assert.strictEqual(approvals[0].tool, 'sidekick_respond');
    assert.ok(!Object.prototype.hasOwnProperty.call(approvals[0], 'args'));
    console.log('Passed\n');

    console.log('Test 3: approving a queued request executes it');
    result = await tools.resolveApproval(approvals[0].id, 'approve', 'test');
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'queued');
    approvals = tools.listApprovals({ status: 'approved' });
    assert.strictEqual(approvals.length, 1);
    console.log('Passed\n');

    console.log('Test 4: exempt tool bypasses approval');
    process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = 'sidekick_respond';
    result = await tools.callTool('sidekick_respond', { text: 'exempt' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'exempt');
    assert.strictEqual(tools.listApprovals({ status: 'pending' }).length, 0);
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Approval Tests Passed!');
  } catch (e) {
    console.error('Approval test failed:', e);
    process.exit(1);
  }
})();
