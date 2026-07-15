const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-evolve');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';

delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/tools')];

const dbStore = require('../src/db');
dbStore.runPendingMigrations();
const { chronologicalLogs, segmentLogs, detectCandidates, classifyOperation, scoreCandidate } = require('../src/evolve/analyzer');
const { substitute, validateCandidate } = require('../src/evolve/validator');
const { candidateToCapability, validateCapability, transition, allowedActions } = require('../src/evolve/lifecycle');
const { refreshCandidates } = require('../src/evolve');
const dynamicTools = require('../src/dynamic-tools');
const { TOOLS, TOOL_DEFS, callTool, setSource, loadProcedures } = require('../src/tools');

function log({ t, n, src = 'mcp', session = 's1', task = 'task1', ok = true, shape = {}, args = null, retry = false, generated = false, summary = 'ok' }) {
  dbStore.appendToolLog({
    t,
    n,
    src,
    ok,
    s: summary,
    session_id: session,
    task_id: task,
    args,
    args_shape: shape,
    arg_fingerprint: 'fp-' + JSON.stringify(shape).length,
    retry,
    generated_procedure: generated ? 'sidekick_generated_loop' : null,
  });
}

function seedServiceDiagnosis({ session = 's1', task = 'task1', src = 'mcp', start = 0, ok = true, retry = false, service = 'sidekick-mcp' } = {}) {
  const base = Date.parse('2026-01-01T00:00:00.000Z') + start;
  log({ t: new Date(base).toISOString(), n: 'sidekick_bash', src, session, task, ok, retry, args: { command: `systemctl status ${service}` }, shape: { command: 'systemctl status <service>' }, summary: ok ? 'service active' : 'service failed' });
  log({ t: new Date(base + 1000).toISOString(), n: 'sidekick_bash', src, session, task, ok, retry, args: { command: `journalctl -u ${service} -n 80 --no-pager` }, shape: { command: 'journalctl -u <service>' }, summary: ok ? 'logs inspected successfully' : 'journalctl error' });
}

(async () => {
  try {
    console.log('Running Evolve Tests...\n');
    setSource('test');

    console.log('Test: newest-first logs are restored to chronology');
    const newestFirst = [
      { t: '2026-01-01T00:00:02.000Z', n: 'c' },
      { t: '2026-01-01T00:00:01.000Z', n: 'b' },
      { t: '2026-01-01T00:00:00.000Z', n: 'a' },
    ];
    assert.deepStrictEqual(chronologicalLogs(newestFirst).map(r => r.name), ['a', 'b', 'c']);

    console.log('Test: source/session/task/gap boundaries are respected');
    const boundaryLogs = [
      { t: '2026-01-01T00:00:00.000Z', n: 'a', src: 'mcp', session_id: 's1', task_id: 't1' },
      { t: '2026-01-01T00:00:01.000Z', n: 'b', src: 'mcp', session_id: 's1', task_id: 't1' },
      { t: '2026-01-01T00:00:02.000Z', n: 'c', src: 'agent', session_id: 's1', task_id: 't1' },
      { t: '2026-01-01T00:00:03.000Z', n: 'd', src: 'agent', session_id: 's1', task_id: 't1' },
      { t: '2026-01-01T02:00:00.000Z', n: 'e', src: 'agent', session_id: 's1', task_id: 't1' },
      { t: '2026-01-01T02:00:01.000Z', n: 'f', src: 'agent', session_id: 's1', task_id: 't1' },
    ];
    assert.strictEqual(segmentLogs(boundaryLogs, { inactivityGapMs: 30 * 60 * 1000 }).length, 3);

    console.log('Test: adjacent generic tools and retries do not become candidates');
    const failed = [];
    for (let i = 0; i < 4; i++) {
      failed.push({ t: `2026-01-01T00:00:0${i}.000Z`, n: 'sidekick_read', src: 'mcp', session_id: `f${i}`, task_id: 't', ok: false, args_shape: { path: '<path>' } });
      failed.push({ t: `2026-01-01T00:00:1${i}.000Z`, n: 'sidekick_hash', src: 'mcp', session_id: `f${i}`, task_id: 't', ok: false, args_shape: { path: '<path>' } });
    }
    assert.strictEqual(detectCandidates(failed, { builtIns: TOOL_DEFS.map(t => t.name) }).length, 0);
    const retried = failed.map(r => ({ ...r, ok: true, retry: true }));
    assert.strictEqual(detectCandidates(retried, { builtIns: TOOL_DEFS.map(t => t.name) }).length, 0);

    const adjacency = [];
    for (let i = 0; i < 3; i++) {
      adjacency.push({ t: `2026-01-01T00:01:0${i}.000Z`, n: 'sidekick_status', src: 'mcp', session_id: `a${i}`, task_id: 't', ok: true, args_shape: {} });
      adjacency.push({ t: `2026-01-01T00:01:1${i}.000Z`, n: 'sidekick_bash', src: 'mcp', session_id: `a${i}`, task_id: 't', ok: true, args: { command: 'pwd' }, args_shape: { command: 'pwd' } });
    }
    assert.strictEqual(detectCandidates(adjacency, { builtIns: TOOL_DEFS.map(t => t.name) }).length, 0, 'status then bash must not become a candidate');

    const plumbing = [];
    for (let i = 0; i < 3; i++) {
      plumbing.push({ t: `2026-01-01T00:02:0${i}.000Z`, n: 'sidekick_resume', src: 'mcp', session_id: `p${i}`, task_id: 't', ok: true, args_shape: { action: 'check' } });
      plumbing.push({ t: `2026-01-01T00:02:1${i}.000Z`, n: 'sidekick_get', src: 'mcp', session_id: `p${i}`, task_id: 't', ok: true, args_shape: { key: '<key>' } });
      plumbing.push({ t: `2026-01-01T00:02:2${i}.000Z`, n: 'sidekick_store', src: 'mcp', session_id: `p${i}`, task_id: 't', ok: true, args_shape: { key: '<key>' } });
    }
    assert.strictEqual(segmentLogs(plumbing).length, 0, 'resume/get/store activity should be filtered before grouping');

    const generatedLoop = [];
    for (let i = 0; i < 3; i++) {
      generatedLoop.push({ t: `2026-01-01T00:03:0${i}.000Z`, n: 'sidekick_generated_service_diagnosis', src: 'mcp', session_id: `g${i}`, task_id: 't', ok: true, generated_procedure: 'sidekick_generated_service_diagnosis', args_shape: { service: '<service>' } });
      generatedLoop.push({ t: `2026-01-01T00:03:1${i}.000Z`, n: 'sidekick_bash', src: 'mcp', session_id: `g${i}`, task_id: 't', ok: true, generated_procedure: 'sidekick_generated_service_diagnosis', args: { command: 'systemctl status sidekick-mcp' }, args_shape: { command: 'systemctl status <service>' } });
    }
    assert.strictEqual(detectCandidates(generatedLoop, { builtIns: TOOL_DEFS.map(t => t.name) }).length, 0, 'generated tool executions must not recursively mine candidates');

    console.log('Test: bash operation semantics are classified from normalized arguments');
    const classified = classifyOperation({ name: 'sidekick_bash', args: { command: 'systemctl status sidekick-mcp' }, argsShape: {}, success: true });
    assert.strictEqual(classified.kind, 'service_status');
    assert.strictEqual(classified.params.service, 'sidekick-mcp');

    console.log('Test: multiple service-diagnosis traces become one parameterized candidate');
    dbStore.clearToolLogs();
    seedServiceDiagnosis({ session: 's1', task: 'a', start: 0, service: 'sidekick-mcp' });
    seedServiceDiagnosis({ session: 's2', task: 'a', start: 10000, service: 'sidekick-dashboard' });
    seedServiceDiagnosis({ session: 's3', task: 'a', start: 20000, service: 'sidekick-agent' });
    const candidates = detectCandidates(dbStore.readToolLogs(100), { builtIns: TOOL_DEFS.map(t => t.name), procedures: [], generated: [], pending: [] });
    assert.strictEqual(candidates.length, 1, 'expected one semantic mined candidate');
    const candidate = candidates[0];
    assert.strictEqual(candidate.title, 'Diagnose a systemd service');
    assert.ok(candidate.steps.some(step => JSON.stringify(step.args).includes('{{service}}')), 'service marker should become a parameter');
    assert.ok(candidate.parameters.service, 'service parameter inferred');
    assert.ok(candidate.qualityGates.semanticTask);
    assert.ok(candidate.scoreBreakdown.parameters > 0);

    console.log('Test: failed tasks do not receive successful workflow candidates');
    dbStore.clearToolLogs();
    seedServiceDiagnosis({ session: 'f1', start: 0, ok: false, service: 'sidekick-mcp' });
    seedServiceDiagnosis({ session: 'f2', start: 10000, ok: false, service: 'sidekick-dashboard' });
    seedServiceDiagnosis({ session: 'f3', start: 20000, ok: false, service: 'sidekick-agent' });
    assert.strictEqual(detectCandidates(dbStore.readToolLogs(100), { builtIns: TOOL_DEFS.map(t => t.name) }).length, 0);

    console.log('Test: no-parameter and zero-savings candidates are score-limited');
    const scoreTraces = [{ completion: { confidence: 'inferred' } }, { completion: { confidence: 'inferred' } }, { completion: { confidence: 'inferred' } }];
    const noParam = scoreCandidate({ traces: scoreTraces, successRate: 1, parameters: {}, family: { title: 'Fixed task' }, duplicatePenalty: 0, riskPenalty: 0, estimatedCallsSaved: 1 });
    assert.ok(noParam.score <= 60, 'no-parameter score must be capped');
    const zeroSavings = scoreCandidate({ traces: scoreTraces, successRate: 1, parameters: { service: { type: 'string' } }, family: { title: 'Task' }, duplicatePenalty: 0, riskPenalty: 0, estimatedCallsSaved: 0 });
    assert.ok(zeroSavings.score <= 50, 'zero-calls-saved score must be capped');

    console.log('Test: duplicate detection penalizes existing procedures/generated tools');
    const dup = detectCandidates(dbStore.readToolLogs(100), {
      builtIns: TOOL_DEFS.map(t => t.name),
      procedures: ['service_diagnosis'],
      generated: ['sidekick_generated_service_diagnosis'],
      pending: [],
    }, { minOccurrences: 1, minScore: 1 });
    assert.ok(dup.every(c => c.duplicate || c.scoreBreakdown.duplicatePenalty > 0));

    console.log('Test: nested substitution and schema validation');
    const nested = substitute({ a: ['{{path}}', { b: '{{port}}' }] }, { path: '/tmp/x', port: 8080 });
    assert.deepStrictEqual(nested, { a: ['/tmp/x', { b: 8080 }] });
    const validation = validateCandidate({
      state: 'candidate',
      parameters: { path: { type: 'string', required: true }, port: { type: 'number', required: false } },
      steps: [{ tool: 'sidekick_read', args: { path: '{{path}}' } }, { tool: 'sidekick_hash', args: { path: '{{path}}' } }],
    }, TOOL_DEFS);
    assert.ok(validation.passed, JSON.stringify(validation));

    console.log('Test: unsafe and missing-tool validation rejection');
    const unsafe = validateCandidate({ parameters: { path: { type: 'string', required: true } }, steps: [{ tool: 'sidekick_bash', args: { command: 'rm -rf {{path}}' } }, { tool: 'missing_tool', args: {} }] }, TOOL_DEFS);
    assert.ok(!unsafe.passed);
    assert.ok(!unsafe.checks.steps.passed);
    assert.ok(!unsafe.checks.security.passed);

    console.log('Test: sidekick_evolve lifecycle requires validation and approval before trial');
    dbStore.clearToolLogs();
    seedServiceDiagnosis({ session: 'l1', start: 0, service: 'sidekick-mcp' });
    seedServiceDiagnosis({ session: 'l2', start: 10000, service: 'sidekick-dashboard' });
    seedServiceDiagnosis({ session: 'l3', start: 20000, service: 'sidekick-agent' });
    const analyze = await TOOLS.sidekick_evolve({ action: 'analyze', limit: 100 });
    assert.ok(!analyze.isError, analyze.content[0].text);
    const stored = dbStore.listGeneratedCapabilities({ includeInactive: true });
    assert.ok(stored.length >= 1);
    const id = stored[0].id;
    const forgedApprove = await TOOLS.sidekick_evolve({ action: 'approve', id, approver: 'test' });
    assert.ok(forgedApprove.isError, 'unvalidated candidates cannot enter trial');
    assert.strictEqual(dbStore.getGeneratedCapability(id).state, 'candidate');
    const validated = await TOOLS.sidekick_evolve({ action: 'validate', id });
    assert.ok(!validated.isError, validated.content[0].text);
    assert.ok(allowedActions(dbStore.getGeneratedCapability(id)).approve, 'validated candidate should allow trial approval');
    const approved = await TOOLS.sidekick_evolve({ action: 'approve', id, approver: 'test' });
    assert.ok(!approved.isError, approved.content[0].text);
    assert.strictEqual(dbStore.getGeneratedCapability(id).state, 'trial');
    assert.strictEqual(dbStore.getGeneratedCapability(id).useCount, 0, 'approval must not execute or increment use count');
    assert.strictEqual(dbStore.listGeneratedToolExecutions({ capabilityId: id }).length, 0, 'approval must not create executions');
    const promoteBeforeUse = await TOOLS.sidekick_evolve({ action: 'promote', id });
    assert.ok(promoteBeforeUse.isError, 'trial cannot promote before a successful invocation');

    console.log('Test: old adjacency candidates are retired safely');
    const junk = candidateToCapability({
      id: 'cand_junk_adjacency',
      proposedToolName: 'sidekick_generated_bash_then_github',
      title: 'bash then github',
      description: 'Repeated successful workflow: sidekick_bash -> sidekick_github',
      state: 'candidate',
      evidence: [{ sessionId: 'old' }],
      evidenceCount: 3,
      successRate: 1,
      score: 89,
      parameters: {},
      steps: [{ tool: 'sidekick_bash', args: { command: 'pwd' } }, { tool: 'sidekick_github', args: { action: 'repo_info' } }],
      risk: 'high',
    });
    dbStore.saveGeneratedCapability(junk);
    refreshCandidates({ TOOL_DEFS, loadProcedures }, { limit: 100 });
    assert.strictEqual(dbStore.getGeneratedCapability('cand_junk_adjacency').state, 'rejected');

    console.log('Test: dynamic discovery, trial invocation, promotion, persistence, deprecation, audit retention');
    const manualCap = candidateToCapability({
      id: 'cand_dynamic_test',
      proposedToolName: 'sidekick_generated_echo_test',
      title: 'echo test',
      description: 'Return generated response',
      state: 'candidate',
      evidence: [{ sessionId: 'manual' }],
      evidenceCount: 3,
      successRate: 1,
      score: 80,
      scoreBreakdown: {},
      parameters: { text: { type: 'string', required: true, maxLength: 100 } },
      steps: [{ tool: 'sidekick_respond', args: { text: '{{text}}' } }],
      risk: 'low',
    });
    validateCapability(manualCap, TOOL_DEFS);
    transition(manualCap, 'trial', { approver: 'test' });
    manualCap.schema = manualCap.validation.schema;
    dbStore.saveGeneratedCapability(manualCap);
    dbStore.syncGeneratedToolRegistry();
    assert.ok(dynamicTools.getDynamicToolDefs().some(t => t.name === 'sidekick_generated_echo_test'));
    assert.ok(require('../src/tools').getToolDefsForSource('mcp').some(t => t.name === 'sidekick_generated_echo_test'));
    const dynResult = await callTool('sidekick_generated_echo_test', { text: 'hello' });
    assert.ok(!dynResult.isError, dynResult.content[0].text);
    assert.strictEqual(dbStore.getGeneratedCapability('cand_dynamic_test').successCount, 1);
    const dynPayload = JSON.parse(dynResult.content[0].text);
    assert.ok(dynPayload.execution_id, 'MCP-triggered generated execution should return an execution id');
    const dynExecution = dbStore.getGeneratedToolExecution(dynPayload.execution_id);
    assert.strictEqual(dynExecution.state, 'succeeded');
    assert.strictEqual(dynExecution.steps.length, 1);
    assert.strictEqual(dynExecution.successCriteriaSatisfied, true);
    const promoted = await TOOLS.sidekick_evolve({ action: 'promote', id: 'cand_dynamic_test' });
    assert.ok(!promoted.isError, promoted.content[0].text);
    assert.ok(dbStore.getGeneratedCapabilityByName('sidekick_generated_echo_test'));
    const deprecated = await TOOLS.sidekick_evolve({ action: 'deprecate', id: 'cand_dynamic_test', reason: 'test complete' });
    assert.ok(!deprecated.isError, deprecated.content[0].text);
    dbStore.syncGeneratedToolRegistry();
    assert.ok(!dynamicTools.getDynamicToolDefs().some(t => t.name === 'sidekick_generated_echo_test'));
    assert.ok(dbStore.listGeneratedToolAudit('cand_dynamic_test').length >= 1, 'audit history retained');

    console.log('Test: generated execution observability records steps, events, redaction, failure, cancellation, and timeout');
    const observedCap = candidateToCapability({
      id: 'cand_observed_test',
      proposedToolName: 'sidekick_generated_observed_test',
      title: 'observed test',
      description: 'Exercise generated execution observability',
      state: 'candidate',
      evidence: [{ sessionId: 'manual' }],
      evidenceCount: 3,
      successRate: 1,
      score: 80,
      parameters: { text: { type: 'string', required: true }, secret: { type: 'string', required: false } },
      steps: [{ tool: 'sidekick_respond', args: { text: '{{text}} {{secret}}' } }, { tool: 'sidekick_respond', args: { text: 'done {{text}}' } }],
      risk: 'low',
    });
    validateCapability(observedCap, TOOL_DEFS);
    transition(observedCap, 'trial', { approver: 'test' });
    observedCap.schema = observedCap.validation.schema;
    dbStore.saveGeneratedCapability(observedCap);
    const events = [];
    const off = dynamicTools.onExecutionEvent(execution => events.push(execution.state));
    const observedRun = await dynamicTools.callDynamicTool('sidekick_generated_observed_test', { text: 'hello', secret: 'ghp_abcdefghijklmnopqrstuvwxyz123456' }, { source: 'dashboard', callTool, executionId: 'gte_observed_success' });
    off();
    assert.ok(!observedRun.isError, observedRun.content[0].text);
    assert.ok(events.includes('running') && events.includes('succeeded'), 'live progress events should include running and succeeded');
    const observedExecution = dbStore.getGeneratedToolExecution('gte_observed_success');
    assert.strictEqual(observedExecution.source, 'dashboard');
    assert.strictEqual(observedExecution.steps.length, 2, 'parent execution should have child step records');
    assert.ok(!JSON.stringify(observedExecution).includes('ghp_abcdefghijklmnopqrstuvwxyz123456'), 'execution records must redact secrets');
    assert.strictEqual(observedExecution.successCriteriaSatisfied, true);
    assert.strictEqual(dbStore.queryToolLogs({ limit: 20 }).some(entry => entry.execution_id === 'gte_observed_success'), true, 'underlying tool logs should carry execution id');
    const platformRows = dbStore.getDb().prepare('SELECT execution_id, parent_execution_id, root_execution_id, state, operation_type, tool_name FROM platform_executions WHERE root_execution_id = ? ORDER BY execution_id').all('gte_observed_success');
    assert.strictEqual(platformRows.length, 3, 'generated execution should create one platform parent and one child per step');
    assert.ok(platformRows.some(row => row.execution_id === 'gte_observed_success' && row.state === 'completed' && row.operation_type === 'generated_tool'));
    assert.ok(platformRows.some(row => row.execution_id === 'gte_observed_success:step:1' && row.parent_execution_id === 'gte_observed_success' && row.state === 'completed' && row.tool_name === 'sidekick_respond'));
    assert.ok(platformRows.some(row => row.execution_id === 'gte_observed_success:step:2' && row.parent_execution_id === 'gte_observed_success' && row.state === 'completed' && row.tool_name === 'sidekick_respond'));
    const platformEvents = dbStore.getDb().prepare('SELECT event_type FROM platform_execution_events WHERE root_execution_id = ? ORDER BY timestamp').all('gte_observed_success').map(row => row.event_type);
    assert.ok(platformEvents.includes('execution.created'), 'platform event stream should include creation events');
    assert.ok(platformEvents.includes('execution.running'), 'platform event stream should include running events');
    assert.ok(platformEvents.includes('execution.completed'), 'platform event stream should include completion events');

    const failedRun = await dynamicTools.callDynamicTool('sidekick_generated_observed_test', { text: 'bad' }, { source: 'mcp', executionId: 'gte_observed_fail', callTool: async (tool, args) => args.text.startsWith('done') ? { isError: true, content: [{ type: 'text', text: 'step failed password=supersecret' }] } : { content: [{ type: 'text', text: 'ok' }] } });
    assert.ok(failedRun.isError, 'failed intermediate step should fail execution');
    const failedExecution = dbStore.getGeneratedToolExecution('gte_observed_fail');
    assert.strictEqual(failedExecution.state, 'failed');
    assert.strictEqual(failedExecution.successCriteriaSatisfied, false);
    assert.ok(!JSON.stringify(failedExecution).includes('supersecret'), 'failure summaries should be redacted');
    assert.strictEqual(dbStore.getDb().prepare('SELECT state FROM platform_executions WHERE execution_id = ?').get('gte_observed_fail').state, 'failed');

    const cancelRun = await dynamicTools.callDynamicTool('sidekick_generated_observed_test', { text: 'cancel' }, { source: 'dashboard', executionId: 'gte_observed_cancel', callTool: async () => { dynamicTools.cancelExecution('gte_observed_cancel'); return { content: [{ type: 'text', text: 'first ok' }] }; } });
    assert.ok(cancelRun.isError, 'cancelled execution should return an error result');
    assert.strictEqual(dbStore.getGeneratedToolExecution('gte_observed_cancel').state, 'cancelled');
    assert.strictEqual(dbStore.getDb().prepare('SELECT state FROM platform_executions WHERE execution_id = ?').get('gte_observed_cancel').state, 'cancelled');

    const timeoutRun = await dynamicTools.callDynamicTool('sidekick_generated_observed_test', { text: 'slow' }, { source: 'dashboard', executionId: 'gte_observed_timeout', timeoutMs: 1, callTool: () => new Promise(resolve => setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }] }), 30)) });
    assert.ok(timeoutRun.isError, 'timed out step should fail execution');
    assert.strictEqual(dbStore.getGeneratedToolExecution('gte_observed_timeout').state, 'timed_out');
    assert.strictEqual(dbStore.getDb().prepare('SELECT state FROM platform_executions WHERE execution_id = ?').get('gte_observed_timeout').state, 'timed_out');

    delete require.cache[require.resolve('../src/dynamic-tools')];
    assert.strictEqual(dbStore.getGeneratedToolExecution('gte_observed_success').state, 'succeeded', 'completed executions should persist across module reload');
    const stats = dbStore.syncGeneratedCapabilityStats('cand_observed_test');
    assert.strictEqual(stats.useCount, 4, 'trial stats should come from completed executions');
    assert.strictEqual(stats.successCount, 1);
    assert.strictEqual(stats.failureCount, 3);

    console.log('Test: feedback usefulness scoring');
    const feedback = await TOOLS.sidekick_evolve({ action: 'feedback', id: 'cand_dynamic_test', useful: true, notes: 'worked' });
    assert.ok(!feedback.isError, feedback.content[0].text);
    assert.ok(dbStore.getGeneratedCapability('cand_dynamic_test').userFeedback.length === 1);

    console.log('Test: backward compatibility with existing stored procedures');
    await TOOLS.sidekick_teach({ action: 'teach_procedure', name: 'legacy_echo', description: 'legacy', parameters: { text: { type: 'string', required: true } }, steps: [{ tool: 'sidekick_respond', args: { text: '{{text}}' } }] });
    assert.ok(loadProcedures().legacy_echo, 'legacy procedure still stored/readable');

    console.log('Test: frontend controls reflect backend allowed transitions');
    const dashboardJs = fs.readFileSync(path.join(__dirname, '..', 'static', 'dashboard.js'), 'utf8');
    assert.ok(dashboardJs.includes('const allowed = item.allowed_actions || {}'), 'dashboard should use backend allowed_actions');
    assert.ok(dashboardJs.includes('allowed.approve ?'), 'approve control should be gated by allowed_actions');
    assert.ok(dashboardJs.includes('allowed.promote ?'), 'promote control should be gated by allowed_actions');
    assert.ok(!dashboardJs.includes("state === 'awaiting_approval' || state === 'validated' || state === 'candidate' ? '<button class=\"btn btn-sm\" onclick=\"approveEvolve"), 'approve button must not be shown for unvalidated candidates');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('\nAll Evolve Tests Passed!');
  } catch (e) {
    console.error('Test failed:', e);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  }
})();
