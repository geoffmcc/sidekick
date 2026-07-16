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
const legacy = require('../src/tools-legacy');
const db = require('../src/db');
const { dispatchTool, dispatchTestTool, callMcpTool, callAgentTool, callDashboardTool } = tools;
const { createRegistry } = require('../src/tools/registry');
const { createExecutionContext, getExecutionContext } = require('../src/tools/context');

console.log('Running Dispatcher Tests...');

(async () => {
  try {
    let result = await dispatchTool({ name: 'sidekick_respond', args: { text: 'ok' }, context: { source: 'mcp', requestId: 'req_success' } });
    assert.strictEqual(result.isError, undefined, 'known tool should execute');
    assert.strictEqual(result.content[0].text, 'ok');

    result = await dispatchTool({ name: 'sidekick_respond', args: { text: 'forged source' }, context: { source: 'dashboard', requestId: 'req_forged_source' } });
    assert.strictEqual(result.isError, undefined, 'generic caller should still execute low-risk tool');
    assert.ok(db.queryToolLogs({ tool: 'sidekick_respond', source: 'mcp', success: true, limit: 20 }).some(row => row.task_id === 'req_forged_source'), 'generic source input should not establish dashboard identity');

    await callAgentTool('sidekick_respond', { text: 'agent source' }, { requestId: 'req_agent_source' });
    await callDashboardTool('sidekick_respond', { text: 'dashboard source' }, { requestId: 'req_dashboard_source' });
    await callMcpTool('sidekick_respond', { text: 'mcp source' }, { requestId: 'req_mcp_source' });
    assert.ok(db.queryToolLogs({ tool: 'sidekick_respond', source: 'agent', success: true, limit: 20 }).some(row => row.task_id === 'req_agent_source'), 'agent wrapper should establish agent identity');
    assert.ok(db.queryToolLogs({ tool: 'sidekick_respond', source: 'dashboard', success: true, limit: 20 }).some(row => row.task_id === 'req_dashboard_source'), 'dashboard wrapper should establish dashboard identity');
    assert.ok(db.queryToolLogs({ tool: 'sidekick_respond', source: 'mcp', success: true, limit: 20 }).some(row => row.task_id === 'req_mcp_source'), 'mcp wrapper should establish mcp identity');

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
    assert.ok(result.isError, 'production descriptor injection should fail');
    assert.strictEqual(result.code, 'descriptor_injection_denied');
    result = await dispatchTestTool({ descriptor: slowDescriptor, args: {}, context: { source: 'test', timeoutMs: 5 } });
    assert.ok(result.isError, 'timeout should fail');
    assert.strictEqual(result.code, 'timed_out_operation_may_continue');
    assert.ok(result.operationMayContinue, 'timeout should not claim legacy handler termination');

    const controller = new AbortController();
    controller.abort();
    result = await dispatchTestTool({ descriptor: slowDescriptor, args: {}, context: { source: 'test', signal: controller.signal } });
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
      dispatchTestTool({ descriptor: contextDescriptor, args: { label: 'a' }, context: { source: 'agent', requestId: 'req_a' } }),
      dispatchTestTool({ descriptor: contextDescriptor, args: { label: 'b' }, context: { source: 'dashboard', requestId: 'req_b' } }),
    ]);
    assert.strictEqual(a.content[0].text, 'a:agent:req_a', 'concurrent context A should not leak');
    assert.strictEqual(b.content[0].text, 'b:dashboard:req_b', 'concurrent context B should not leak');

    assert.throws(() => createRegistry([
      { name: 'dup', description: 'one', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
      { name: 'dup', description: 'two', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
    ]), /Duplicate tool descriptor/, 'duplicate descriptors should fail');
    assert.throws(() => createRegistry([
      { name: 'one', aliases: ['two'], description: 'one', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
      { name: 'two', description: 'two', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
    ]), /Duplicate tool alias/, 'alias before canonical collision should fail');
    assert.throws(() => createRegistry([
      { name: 'two', description: 'two', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
      { name: 'one', aliases: ['two'], description: 'one', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
    ]), /Duplicate tool alias/, 'canonical before alias collision should fail');
    assert.throws(() => createRegistry([
      { name: 'one', aliases: ['shared'], description: 'one', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
      { name: 'two', aliases: ['shared'], description: 'two', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
    ]), /Duplicate tool alias/, 'duplicate aliases should fail');
    assert.doesNotThrow(() => createRegistry([
      { name: 'self_alias', aliases: ['self_alias'], description: 'self', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) },
    ]), 'self alias should be allowed');
    assert.throws(() => createRegistry([
      { name: 'bad_risk', description: 'bad', schema: z.object({}), category: 'Test', handler: async () => ({ content: [] }) },
    ]), /missing risk/, 'missing risk should fail');

    const originalPolicy = legacy.enforceToolPolicy;
    let invoked = false;
    legacy.enforceToolPolicy = () => { throw new Error('policy failed with Bearer ghp_abcdefghijklmnopqrstuvwxyz123456'); };
    result = await dispatchTestTool({ descriptor: { name: 'policy_throw_test', description: 'policy throw', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => { invoked = true; return { content: [] }; } }, args: {}, context: { source: 'test' } });
    assert.ok(result.isError);
    assert.strictEqual(result.code, 'policy_evaluation_failed');
    assert.strictEqual(invoked, false, 'handler must not run after policy exception');
    assert.ok(!result.content[0].text.includes('ghp_'), 'policy errors should be sanitized');
    legacy.enforceToolPolicy = originalPolicy;

    const originalApproval = legacy.getApprovalDecision;
    process.env.SIDEKICK_APPROVAL_MODE = 'risky';
    legacy.getApprovalDecision = () => { throw new Error('approval failed password=hunter2'); };
    result = await dispatchTestTool({ descriptor: { name: 'approval_throw_test', description: 'approval throw', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [] }) }, args: {}, context: { source: 'test' } });
    assert.ok(result.isError);
    assert.strictEqual(result.code, 'approval_evaluation_failed');
    assert.ok(!result.content[0].text.includes('hunter2'), 'approval errors should be sanitized');
    legacy.getApprovalDecision = originalApproval;
    process.env.SIDEKICK_APPROVAL_MODE = 'off';

    const originalLog = legacy.logToolCall;
    legacy.logToolCall = () => { throw new Error('audit failed Authorization: Bearer secret-token'); };
    result = await dispatchTestTool({ descriptor: { name: 'audit_throw_test', description: 'audit throw', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => ({ content: [{ type: 'text', text: 'audit ok' }] }) }, args: {}, context: { source: 'test' } });
    assert.strictEqual(result.content[0].text, 'audit ok', 'audit failure should not become handler failure');
    assert.strictEqual(result.auditFailed, true, 'audit failure should be observable');
    legacy.logToolCall = originalLog;

    result = await dispatchTestTool({ descriptor: { name: 'sanitize_throw_test', description: 'sanitize throw', schema: z.object({}), risk: 'low', category: 'Test', handler: async () => { throw new Error('boom Authorization: Bearer secret-token\n    at secret (/tmp/secret.js:1:2)'); } }, args: {}, context: { source: 'test' } });
    assert.ok(result.isError);
    assert.strictEqual(result.code, 'handler_error');
    assert.ok(!result.content[0].text.includes('secret-token'));
    assert.ok(!result.content[0].text.includes('/tmp/secret.js'));

    db.saveGeneratedCapability({
      id: 'cap_dispatcher_shadow_respond',
      name: 'respond',
      state: 'active',
      title: 'Shadow respond',
      description: 'Should not shadow builtin',
      risk: 'low',
      schema: { type: 'object', properties: {}, required: [] },
      steps: [{ tool: 'sidekick_respond', args: { text: 'generated shadow' } }],
    });
    result = await dispatchTool({ name: 'respond', args: { text: 'builtin wins' }, context: { source: 'mcp', requestId: 'req_shadow' } });
    assert.strictEqual(result.content[0].text, 'builtin wins', 'generated tool must not silently shadow builtin');

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
