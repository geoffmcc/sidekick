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
const { chronologicalLogs, segmentLogs, detectCandidates } = require('../src/evolve/analyzer');
const { substitute, validateCandidate } = require('../src/evolve/validator');
const { candidateToCapability, validateCapability, transition } = require('../src/evolve/lifecycle');
const dynamicTools = require('../src/dynamic-tools');
const { TOOLS, TOOL_DEFS, callTool, setSource, loadProcedures } = require('../src/tools');

function log({ t, n, src = 'mcp', session = 's1', task = 'task1', ok = true, shape = {}, retry = false, generated = false, summary = 'ok' }) {
  dbStore.appendToolLog({
    t,
    n,
    src,
    ok,
    s: summary,
    session_id: session,
    task_id: task,
    args_shape: shape,
    arg_fingerprint: 'fp-' + JSON.stringify(shape).length,
    retry,
    generated_procedure: generated ? 'sidekick_generated_loop' : null,
  });
}

function seedWorkflow({ session = 's1', task = 'task1', src = 'mcp', start = 0, ok = true, retry = false, shape = '<path>' } = {}) {
  const base = Date.parse('2026-01-01T00:00:00.000Z') + start;
  log({ t: new Date(base).toISOString(), n: 'sidekick_read', src, session, task, ok, retry, shape: { path: shape } });
  log({ t: new Date(base + 1000).toISOString(), n: 'sidekick_hash', src, session, task, ok, retry, shape: { path: shape, algorithm: 'sha256' } });
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

    console.log('Test: failed loops and retries do not become candidates');
    const failed = [];
    for (let i = 0; i < 4; i++) {
      failed.push({ t: `2026-01-01T00:00:0${i}.000Z`, n: 'sidekick_read', src: 'mcp', session_id: `f${i}`, task_id: 't', ok: false, args_shape: { path: '<path>' } });
      failed.push({ t: `2026-01-01T00:00:1${i}.000Z`, n: 'sidekick_hash', src: 'mcp', session_id: `f${i}`, task_id: 't', ok: false, args_shape: { path: '<path>' } });
    }
    assert.strictEqual(detectCandidates(failed, { builtIns: TOOL_DEFS.map(t => t.name) }).length, 0);
    const retried = failed.map(r => ({ ...r, ok: true, retry: true }));
    assert.strictEqual(detectCandidates(retried, { builtIns: TOOL_DEFS.map(t => t.name) }).length, 0);

    console.log('Test: equivalent traces become one parameterized candidate');
    dbStore.clearToolLogs();
    seedWorkflow({ session: 's1', task: 'a', start: 0 });
    seedWorkflow({ session: 's2', task: 'a', start: 10000 });
    seedWorkflow({ session: 's3', task: 'a', start: 20000 });
    const candidates = detectCandidates(dbStore.readToolLogs(100), { builtIns: TOOL_DEFS.map(t => t.name), procedures: [], generated: [], pending: [] });
    assert.ok(candidates.length >= 1, 'expected at least one mined candidate');
    const candidate = candidates[0];
    assert.ok(candidate.steps.some(step => JSON.stringify(step.args).includes('{{path}}')), 'path marker should become a parameter');
    assert.ok(candidate.parameters.path, 'path parameter inferred');

    console.log('Test: different arguments produce distinct signatures when constants differ');
    dbStore.clearToolLogs();
    seedWorkflow({ session: 'a1', start: 0, shape: '<path>' });
    log({ t: '2026-01-01T00:00:20.000Z', n: 'sidekick_read', session: 'b1', task: 'x', shape: { path: '<path>' } });
    log({ t: '2026-01-01T00:00:21.000Z', n: 'sidekick_hash', session: 'b1', task: 'x', shape: { path: '<path>', algorithm: 'sha1' } });
    const split = detectCandidates(dbStore.readToolLogs(100), { builtIns: TOOL_DEFS.map(t => t.name) }, { minOccurrences: 1, minScore: 1 });
    assert.ok(new Set(split.map(c => JSON.stringify(c.steps))).size >= 2);

    console.log('Test: duplicate detection penalizes existing procedures/generated tools');
    const dup = detectCandidates(dbStore.readToolLogs(100), {
      builtIns: TOOL_DEFS.map(t => t.name),
      procedures: ['read_then_hash'],
      generated: ['sidekick_generated_read_then_hash'],
      pending: [],
    }, { minOccurrences: 1, minScore: 1 });
    assert.ok(dup.some(c => c.duplicate || c.scoreBreakdown.duplicatePenalty > 0));

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
    seedWorkflow({ session: 'l1', start: 0 });
    seedWorkflow({ session: 'l2', start: 10000 });
    seedWorkflow({ session: 'l3', start: 20000 });
    const analyze = await TOOLS.sidekick_evolve({ action: 'analyze', limit: 100 });
    assert.ok(!analyze.isError, analyze.content[0].text);
    const stored = dbStore.listGeneratedCapabilities({ includeInactive: true });
    assert.ok(stored.length >= 1);
    const id = stored[0].id;
    const validated = await TOOLS.sidekick_evolve({ action: 'validate', id });
    assert.ok(!validated.isError, validated.content[0].text);
    const approved = await TOOLS.sidekick_evolve({ action: 'approve', id, approver: 'test' });
    assert.ok(!approved.isError, approved.content[0].text);
    assert.strictEqual(dbStore.getGeneratedCapability(id).state, 'trial');
    const promoteBeforeUse = await TOOLS.sidekick_evolve({ action: 'promote', id });
    assert.ok(promoteBeforeUse.isError, 'trial cannot promote before a successful invocation');

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
    const promoted = await TOOLS.sidekick_evolve({ action: 'promote', id: 'cand_dynamic_test' });
    assert.ok(!promoted.isError, promoted.content[0].text);
    assert.ok(dbStore.getGeneratedCapabilityByName('sidekick_generated_echo_test'));
    const deprecated = await TOOLS.sidekick_evolve({ action: 'deprecate', id: 'cand_dynamic_test', reason: 'test complete' });
    assert.ok(!deprecated.isError, deprecated.content[0].text);
    dbStore.syncGeneratedToolRegistry();
    assert.ok(!dynamicTools.getDynamicToolDefs().some(t => t.name === 'sidekick_generated_echo_test'));
    assert.ok(dbStore.listGeneratedToolAudit('cand_dynamic_test').length >= 1, 'audit history retained');

    console.log('Test: feedback usefulness scoring');
    const feedback = await TOOLS.sidekick_evolve({ action: 'feedback', id: 'cand_dynamic_test', useful: true, notes: 'worked' });
    assert.ok(!feedback.isError, feedback.content[0].text);
    assert.ok(dbStore.getGeneratedCapability('cand_dynamic_test').userFeedback.length === 1);

    console.log('Test: backward compatibility with existing stored procedures');
    await TOOLS.sidekick_teach({ action: 'teach_procedure', name: 'legacy_echo', description: 'legacy', parameters: { text: { type: 'string', required: true } }, steps: [{ tool: 'sidekick_respond', args: { text: '{{text}}' } }] });
    assert.ok(loadProcedures().legacy_echo, 'legacy procedure still stored/readable');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('\nAll Evolve Tests Passed!');
  } catch (e) {
    console.error('Test failed:', e);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  }
})();
