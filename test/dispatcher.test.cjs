const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const TEST_DATA_DIR = path.join(__dirname, 'test-dispatcher-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'dispatcher-test-secret-key';
delete process.env.SIDEKICK_BLOCKED_TOOLS;
delete process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS;

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];

const tools = require('../src/tools');
const db = require('../src/db');
const { dispatchTool } = tools;
const { createRegistry } = require('../src/tools/registry');
const { createExecutionContext, getExecutionContext } = require('../src/tools/context');

console.log('Running Dispatcher Tests...');

(async () => {
  try {
    let result = await dispatchTool({ name: 'sidekick_respond', args: { text: 'ok' }, context: { source: 'mcp', requestId: 'req_success' } });
    assert.strictEqual(result.isError, undefined, 'known tool should execute');
    assert.strictEqual(result.content[0].text, 'ok');

    result = await dispatchTool({ name: 'sidekick_missing', args: {}, context: { source: 'mcp', requestId: 'req_unknown' } });
    assert.ok(result.isError, 'unknown tool should fail');
    assert.strictEqual(result.code, 'unknown_tool');

    result = await dispatchTool({ name: 'sidekick_respond', args: {}, context: { source: 'mcp', requestId: 'req_invalid' } });
    assert.ok(result.isError, 'invalid args should fail before handler');
    assert.strictEqual(result.code, 'validation_failed');

    process.env.SIDEKICK_BLOCKED_TOOLS = 'sidekick_respond';
    result = await dispatchTool({ name: 'sidekick_respond', args: { text: 'blocked' }, context: { source: 'mcp', requestId: 'req_policy' } });
    assert.ok(result.isError, 'policy denial should fail');
    assert.strictEqual(result.code, 'policy_denied');
    delete process.env.SIDEKICK_BLOCKED_TOOLS;

    process.env.SIDEKICK_APPROVAL_MODE = 'risky';
    process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = 'sidekick_respond';
    result = await dispatchTool({ name: 'sidekick_respond', args: { text: 'needs approval', token: 'secret-token-value' }, context: { source: 'mcp', requestId: 'req_approval' } });
    assert.ok(result.isError, 'approval-required tool should not execute immediately');
    assert.strictEqual(result.code, 'approval_required');
    assert.ok(result.approvalRequired);
    assert.ok(result.approvalId);
    const approval = tools.listApprovals({ status: 'pending' })[0];
    assert.ok(approval, 'approval should be queued');
    assert.ok(!approval.args_preview.includes('secret-token-value'), 'approval preview should redact sensitive values');
    process.env.SIDEKICK_APPROVAL_MODE = 'off';
    process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = '';

    const slowDescriptor = {
      name: 'slow_test',
      description: 'Slow test descriptor',
      schema: z.object({}),
      risk: 'low',
      category: 'Test',
      handler: () => new Promise(resolve => setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }] }), 50)),
    };
    result = await dispatchTool({ descriptor: slowDescriptor, args: {}, context: { source: 'test', timeoutMs: 5 } });
    assert.ok(result.isError, 'timeout should fail');
    assert.strictEqual(result.code, 'timeout');

    const controller = new AbortController();
    controller.abort();
    result = await dispatchTool({ descriptor: slowDescriptor, args: {}, context: { source: 'test', signal: controller.signal } });
    assert.ok(result.isError, 'cancelled signal should fail');
    assert.strictEqual(result.code, 'cancelled');

    const contextDescriptor = {
      name: 'context_test',
      description: 'Context test descriptor',
      schema: z.object({ label: z.string() }),
      risk: 'low',
      category: 'Test',
      handler: async ({ label }) => {
        await new Promise(resolve => setTimeout(resolve, label === 'a' ? 20 : 1));
        const ctx = getExecutionContext();
        return { content: [{ type: 'text', text: `${label}:${ctx.source}:${ctx.requestId}` }] };
      },
    };
    const [a, b] = await Promise.all([
      dispatchTool({ descriptor: contextDescriptor, args: { label: 'a' }, context: { source: 'agent', requestId: 'req_a' } }),
      dispatchTool({ descriptor: contextDescriptor, args: { label: 'b' }, context: { source: 'dashboard', requestId: 'req_b' } }),
    ]);
    assert.strictEqual(a.content[0].text, 'a:agent:req_a', 'concurrent context A should not leak');
    assert.strictEqual(b.content[0].text, 'b:dashboard:req_b', 'concurrent context B should not leak');

    assert.throws(() => createRegistry([
      { name: 'dup', description: 'one', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
      { name: 'dup', description: 'two', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
    ]), /Duplicate tool descriptor/, 'duplicate descriptors should fail');
    assert.throws(() => createRegistry([
      { name: 'bad_risk', description: 'bad', schema: z.object({}), category: 'Test', handler: async () => ({ content: [] }) },
    ]), /missing risk/, 'missing risk should fail');

    db.saveGeneratedCapability({
      id: 'cap_dispatcher_bad_risk',
      name: 'generated_bad_risk',
      state: 'active',
      title: 'Bad risk generated tool',
      description: 'Should fail closed',
      risk: 'not-a-risk',
      schema: { type: 'object', properties: {}, required: [] },
      steps: [{ tool: 'sidekick_respond', args: { text: 'should not run' } }],
    });
    result = await dispatchTool({ name: 'generated_bad_risk', args: {}, context: { source: 'mcp', requestId: 'req_generated_risk' } });
    assert.ok(result.isError, 'generated tool with invalid risk should fail closed');
    assert.strictEqual(result.code, 'risk_unclassified');

    assert.ok(db.queryToolLogs({ tool: 'sidekick_respond', source: 'mcp', success: true, limit: 10 }).length >= 1, 'success should be logged with source');
    assert.ok(db.queryToolLogs({ tool: 'sidekick_missing', success: false, limit: 10 }).length >= 1, 'unknown tool should be logged');
    assert.ok(db.queryToolLogs({ tool: 'generated_bad_risk', success: false, limit: 10 }).length >= 1, 'risk failure should be logged');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('Dispatcher Tests passed');
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
