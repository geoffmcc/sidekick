/**
 * Tool-log correlation test.
 *
 * Predict's sequence detectors need a real execution boundary on tool_logs.
 * The MCP transport supplies a per-connection `sessionId`; this pins that it is
 * threaded into the execution context, that `project` is recorded only when the
 * call names one, and that no constant is substituted for a session.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-tool-log-correlation');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

const ROOT = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf-8');

console.log('Running Tool Log Correlation Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

// Rebuild the helper in isolation from the real source so the assertions below
// exercise the shipped logic rather than a copy.
function loadToolCallContext() {
  const match = indexSource.match(/function toolCallContext\(args, extra\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'toolCallContext is defined in src/index.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}; return toolCallContext;`)();
}

console.log('TLC.1: the MCP session id reaches the execution context');
test('sessionId from the transport is threaded through', () => {
  const toolCallContext = loadToolCallContext();
  const ctx = toolCallContext({}, { sessionId: 'sess-abc123', requestInfo: { requestId: 'req-1' } });
  assert.equal(ctx.sessionId, 'sess-abc123', 'session id is passed through');
  assert.equal(ctx.requestId, 'req-1', 'request id is preserved');
});

test('a missing session id is left absent rather than invented', () => {
  const toolCallContext = loadToolCallContext();
  const ctx = toolCallContext({}, { requestInfo: { requestId: 'req-2' } });
  assert.ok(!('sessionId' in ctx), 'no sessionId key when the transport supplies none');
  assert.equal(ctx.requestId, 'req-2', 'request id still recorded');
});

test('every MCP registration site passes the shared context builder', () => {
  const callSites = indexSource.match(/callMcpTool\([^)]*\)/g) || [];
  assert.ok(callSites.length >= 3, `expected at least 3 callMcpTool sites, found ${callSites.length}`);
  for (const site of callSites) {
    assert.ok(/toolCallContext\(args, extra\)/.test(site),
      `call site does not use toolCallContext: ${site}`);
  }
  assert.ok(!/requestId: extra\?\.requestInfo\?\.requestId\s*\}/.test(
    indexSource.replace(/function toolCallContext[\s\S]*?\n\}/, '')
  ), 'no registration site builds its context inline any more');
});

console.log('TLC.2: a constant is never substituted for a session boundary');
test('the MCP path does not fall back to a fixed session id', () => {
  // A constant session id would place every call ever made into one sequence and
  // let Predict infer adjacency between unrelated calls — the defect that
  // produced reversed, cross-session predictions in the first place.
  const helper = indexSource.match(/function toolCallContext[\s\S]*?\n\}/)[0];
  assert.ok(!/SIDEKICK_SESSION_ID/.test(helper),
    'toolCallContext must not read a constant session id from the environment');
  assert.ok(/Never substitute a constant/.test(indexSource),
    'the reasoning is recorded next to the code');
});

console.log('TLC.3: project is observed, not guessed');
test('project is recorded only when the call names one', () => {
  const toolCallContext = loadToolCallContext();
  assert.equal(toolCallContext({ project: 'sidekick' }, {}).project, 'sidekick', 'named project recorded');
  assert.equal(toolCallContext({ project: '  sidekick  ' }, {}).project, 'sidekick', 'trimmed');
  assert.ok(!('project' in toolCallContext({}, {})), 'absent when not named');
  assert.ok(!('project' in toolCallContext({ project: '   ' }, {})), 'blank is not a project');
  assert.ok(!('project' in toolCallContext({ project: 42 }, {})), 'non-string is not a project');
  assert.ok(!('project' in toolCallContext(null, {})), 'null args handled');
});

console.log('TLC.4: the context reaches tool_logs as a usable boundary');
test('logged calls sharing a session form one sequence, distinct sessions do not', () => {
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/predict')];
  const dbStore = require('../src/db');
  const predictEngine = require('../src/predict');

  const t0 = Date.now();
  // Two calls in one session, one call in another.
  dbStore.appendToolLog({ t: new Date(t0).toISOString(), n: 'alpha', ok: true, src: 'mcp', session_id: 'sess-A', project: 'demo', s: 'a' });
  dbStore.appendToolLog({ t: new Date(t0 + 500).toISOString(), n: 'beta', ok: true, src: 'mcp', session_id: 'sess-A', project: 'demo', s: 'b' });
  dbStore.appendToolLog({ t: new Date(t0 + 1000).toISOString(), n: 'gamma', ok: true, src: 'mcp', session_id: 'sess-B', project: 'demo', s: 'c' });

  const rows = dbStore.getDb().prepare("SELECT * FROM tool_logs ORDER BY timestamp DESC").all();
  const { segments } = predictEngine.buildSequences(rows.map(predictEngine.normalizeToolLog), {});

  assert.equal(segments.length, 2, 'one segment per session');
  const bySize = segments.map(s => s.logs.length).sort();
  assert.deepStrictEqual(bySize, [1, 2], 'sess-A yields an adjacent pair, sess-B stands alone');

  const pair = segments.find(s => s.logs.length === 2);
  assert.deepStrictEqual(pair.logs.map(l => l.tool_name), ['alpha', 'beta'], 'chronological order within the session');
});

test('without a session id the same calls yield no sequence at all', () => {
  const predictEngine = require('../src/predict');
  const t0 = Date.now();
  const unscoped = [
    { id: 1, timestamp: new Date(t0).toISOString(), tool_name: 'alpha', success: 1, project: 'demo', session_id: null, correlation_id: 'c1', task_id: null },
    { id: 2, timestamp: new Date(t0 + 500).toISOString(), tool_name: 'beta', success: 1, project: 'demo', session_id: null, correlation_id: 'c2', task_id: null },
  ].map(predictEngine.normalizeToolLog);

  const { segments } = predictEngine.buildSequences(unscoped, {});
  // Per-call correlation ids are identifiers, not grouping keys: each becomes its
  // own segment, so no adjacency is inferred.
  assert.equal(segments.length, 2, 'each per-call correlation id is its own segment');
  assert.ok(segments.every(s => s.logs.length === 1), 'no adjacent pair is manufactured');
});

console.log('\nTool Log Correlation tests: ' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
