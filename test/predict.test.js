const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-predict');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/predict')];
const dbStore = require('../src/db');
const predictEngine = require('../src/predict');

console.log('Running Predict Tests...\n');

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

function assertEqual(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg || `expected ${expected}, got ${actual}`);
}
function assertOk(val, msg) {
  assert.ok(val, msg || `expected truthy, got ${val}`);
}

const T0 = Date.now();
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

// Helper: build a normalized log without touching the database.
function logRow(over) {
  return predictEngine.normalizeToolLog(Object.assign({
    id: 1, timestamp: iso(0), tool_name: 'x', success: 1,
    project: 'p', session_id: 's', correlation_id: null, task_id: null,
    error_category: null, arg_fingerprint: null, summary: '', result_summary: ''
  }, over));
}

console.log('Predict.1: engineStatus returns the canonical contract');
test('engineStatus shape', () => {
  const s = predictEngine.engineStatus();
  assertOk(s.ok === true, 'ok is true');
  assertOk(Array.isArray(s.rules) && s.rules.length > 0, 'has rules');
  assertEqual(s.active, 0, 'active is 0 initially');
  assertEqual(s.total, 0, 'total is 0 initially');
  assertEqual(s.terminal, 0, 'terminal is 0 initially');
  assertOk(typeof s.retention_days === 'number', 'retention_days is a real number');
  assertOk(Array.isArray(s.detectors), 'detectors is an array');
  assertOk(s.detectors.every(d => typeof d.enabled === 'boolean'), 'each detector reports enabled');
  // Backwards-compatible aliases retained for existing MCP consumers.
  assertEqual(s.active_predictions, s.active, 'active_predictions aliases active');
  assertEqual(s.total_predictions, s.total, 'total_predictions aliases total');
});

console.log('Predict.2: analysis requires an explicit scope');
test('unscoped analyze is refused', () => {
  const result = predictEngine.analyze({});
  assertEqual(result.ok, false, 'empty options are rejected');
  assertOk(/scope/i.test(result.error), 'error explains that scope is required');
});

test('global analysis must be selected deliberately', () => {
  const result = predictEngine.analyze({ scope: 'global' });
  assertEqual(result.ok, true, 'explicit global scope is accepted');
  assertEqual(result.scope.mode, 'global', 'scope mode recorded');
  assertEqual(result.scope.project, null, 'global scope has no project');
});

// --- 1 & 2: chronological direction ---

console.log('Predict.3: next_action asserts the exact chronological direction');
test('knowledge -> tools produces the forward relationship only', () => {
  for (let i = 0; i < 3; i++) {
    dbStore.appendToolLog({ t: iso(i * 1000), n: 'knowledge', ok: true, src: 'mcp', session_id: `dir-${i}`, project: 'dir_project', s: 'searched docs' });
    dbStore.appendToolLog({ t: iso(i * 1000 + 500), n: 'tools', ok: true, src: 'mcp', session_id: `dir-${i}`, project: 'dir_project', s: 'inspected catalog' });
  }
  const result = predictEngine.analyze({ project: 'dir_project' });
  assertOk(result.ok, 'analysis ok');
  const next = result.predictions.find(p => p.type === 'next_action');
  assertOk(next, 'has a next_action prediction');
  assertEqual(next.subject, 'After knowledge, tools commonly follows', 'exact forward direction');
  assert.ok(!result.predictions.some(p => p.subject === 'After tools, knowledge commonly follows'),
    'the reversed relationship must not be produced');
  assertEqual(next.confidence, 'medium', 'three observations produce medium confidence');
  assertOk(next.observation_count >= 3, 'observation count recorded');
  assertOk(predictEngine.getPredictionEvidence(next.id).length >= 1, 'evidence stored');
});

test('descending SQL retrieval does not reverse sequences', () => {
  const db = dbStore.getDb();
  // Query in the same descending order the engine uses for recency selection.
  const rows = db.prepare(
    "SELECT * FROM tool_logs WHERE project = ? ORDER BY timestamp DESC, id DESC"
  ).all('dir_project');
  assertOk(rows.length >= 6, 'fixture rows present');
  assertEqual(rows[0].tool_name, 'tools', 'raw query really is newest-first');

  const { segments } = predictEngine.buildSequences(rows.map(predictEngine.normalizeToolLog), {});
  assertOk(segments.length >= 3, 'one segment per session');
  for (const seg of segments) {
    const names = seg.logs.map(l => l.tool_name);
    assert.deepStrictEqual(names, ['knowledge', 'tools'], 'segment is oldest-to-newest regardless of query order');
    for (let i = 1; i < seg.logs.length; i++) {
      assertOk(seg.logs[i].time >= seg.logs[i - 1].time, 'timestamps ascend');
    }
  }
});

test('success column maps onto ok (no ok column exists on tool_logs)', () => {
  assertEqual(logRow({ success: 1 }).ok, true, 'success=1 is ok');
  assertEqual(logRow({ success: 0 }).ok, false, 'success=0 is not ok');
  const raw = dbStore.getDb().prepare('SELECT * FROM tool_logs LIMIT 1').get();
  assertOk(!('ok' in raw), 'tool_logs has no ok column — detectors must normalize');
});

// --- 3-6: boundary isolation ---

console.log('Predict.4: sequences respect real execution boundaries');
test('records without a durable correlation id are skipped, not globally stitched', () => {
  const logs = [
    logRow({ id: 1, tool_name: 'a', session_id: null, correlation_id: null, task_id: null, timestamp: iso(0) }),
    logRow({ id: 2, tool_name: 'b', session_id: null, correlation_id: null, task_id: null, timestamp: iso(1000) }),
    logRow({ id: 3, tool_name: 'c', session_id: null, correlation_id: null, task_id: null, timestamp: iso(2000) }),
  ];
  const { segments, skippedUnscoped } = predictEngine.buildSequences(logs, {});
  assertEqual(segments.length, 0, 'no synthetic _global sequence is built');
  assertEqual(skippedUnscoped, 3, 'unscoped records are counted as skipped');
});

test('separate sessions are not stitched together', () => {
  const logs = [
    logRow({ id: 1, tool_name: 'a', session_id: 's1', timestamp: iso(0) }),
    logRow({ id: 2, tool_name: 'b', session_id: 's2', timestamp: iso(1000) }),
  ];
  const { segments } = predictEngine.buildSequences(logs, {});
  assertEqual(segments.length, 2, 'each session is its own sequence');
  assertOk(segments.every(s => s.logs.length === 1), 'no cross-session adjacency');
});

test('separate projects are not stitched even under one session id', () => {
  const logs = [
    logRow({ id: 1, tool_name: 'a', session_id: 'shared', project: 'proj_a', timestamp: iso(0) }),
    logRow({ id: 2, tool_name: 'b', session_id: 'shared', project: 'proj_b', timestamp: iso(1000) }),
  ];
  const { segments } = predictEngine.buildSequences(logs, {});
  assertEqual(segments.length, 2, 'project participates in the boundary key');
});

test('a large time gap splits a reused session identifier', () => {
  const gapMs = 31 * 60 * 1000; // beyond the 30 minute default
  const logs = [
    logRow({ id: 1, tool_name: 'a', session_id: 'reused', timestamp: iso(0) }),
    logRow({ id: 2, tool_name: 'b', session_id: 'reused', timestamp: iso(1000) }),
    logRow({ id: 3, tool_name: 'c', session_id: 'reused', timestamp: iso(gapMs) }),
    logRow({ id: 4, tool_name: 'd', session_id: 'reused', timestamp: iso(gapMs + 1000) }),
  ];
  const { segments } = predictEngine.buildSequences(logs, {});
  assertEqual(segments.length, 2, 'the gap splits one identifier into two sequences');
  assert.deepStrictEqual(segments[0].logs.map(l => l.tool_name), ['a', 'b'], 'first segment');
  assert.deepStrictEqual(segments[1].logs.map(l => l.tool_name), ['c', 'd'], 'second segment');
});

test('unscoped tool logs cannot produce a next_action prediction', () => {
  for (let i = 0; i < 8; i++) {
    dbStore.appendToolLog({ t: iso(60000 + i * 1000), n: i % 2 ? 'beta' : 'alpha', ok: true, src: 'mcp', project: 'unscoped_project', s: 'x' });
  }
  const result = predictEngine.analyze({ project: 'unscoped_project' });
  assertEqual(result.created, 0, 'no predictions from unscoped adjacency');
  assertOk(result.scope.mode === 'project', 'scope recorded');
});

// --- 7 & 8: prerequisite inference ---

console.log('Predict.5: prerequisites require repeated recovery evidence');
test('a failure followed by an unrelated success does not create a prerequisite', () => {
  for (let i = 0; i < 4; i++) {
    dbStore.appendToolLog({ t: iso(120000 + i * 10000), n: 'alpha', ok: false, src: 'mcp', session_id: `noprereq-${i}`, project: 'noprereq', error_category: 'timeout', s: 'failed' });
    dbStore.appendToolLog({ t: iso(120000 + i * 10000 + 1000), n: 'beta', ok: true, src: 'mcp', session_id: `noprereq-${i}`, project: 'noprereq', s: 'ok' });
  }
  const result = predictEngine.analyze({ project: 'noprereq' });
  const prereq = result.predictions.filter(p => p.type === 'missing_prerequisite');
  assertEqual(prereq.length, 0, 'A failed then B succeeded is not evidence that A requires B');
});

test('repeated fail -> other succeeds -> retry succeeds creates a prerequisite', () => {
  for (let i = 0; i < 2; i++) {
    const base = 200000 + i * 60000;
    const sid = `prereq-${i}`;
    dbStore.appendToolLog({ t: iso(base), n: 'deploy', ok: false, src: 'mcp', session_id: sid, project: 'prereq_project', error_category: 'auth', s: 'denied' });
    dbStore.appendToolLog({ t: iso(base + 1000), n: 'login', ok: true, src: 'mcp', session_id: sid, project: 'prereq_project', s: 'authenticated' });
    dbStore.appendToolLog({ t: iso(base + 2000), n: 'deploy', ok: true, src: 'mcp', session_id: sid, project: 'prereq_project', s: 'deployed' });
  }
  const result = predictEngine.analyze({ project: 'prereq_project' });
  const prereq = result.predictions.find(p => p.type === 'missing_prerequisite');
  assertOk(prereq, 'recovery evidence produces a prerequisite prediction');
  assertEqual(prereq.subject, 'deploy may require login first', 'correct direction of the requirement');
  assertOk(predictEngine.getPredictionEvidence(prereq.id).length >= 2, 'each recovery is cited as evidence');
});

// --- 9 & 10: failure thresholds ---

console.log('Predict.6: likely_failure requires meaningful evidence');
test('two failures among many successes do not create a likely_failure', () => {
  for (let i = 0; i < 20; i++) {
    dbStore.appendToolLog({ t: iso(300000 + i * 1000), n: 'stable', ok: true, src: 'mcp', session_id: `stable-${i % 4}`, project: 'stable_project', s: 'ok' });
  }
  for (let i = 0; i < 2; i++) {
    dbStore.appendToolLog({ t: iso(320000 + i * 1000), n: 'stable', ok: false, src: 'mcp', session_id: `stable-${i}`, project: 'stable_project', error_category: 'timeout', s: 'blip' });
  }
  const result = predictEngine.analyze({ project: 'stable_project' });
  const fails = result.predictions.filter(p => p.type === 'likely_failure');
  assertEqual(fails.length, 0, 'a 9% failure rate is noise, not a prediction');
  assertOk(result.rejected_by_reason.insufficient_failure_evidence >= 1,
    'the rejection is recorded with a reason');
});

test('a consistently failing tool with recent evidence creates a likely_failure', () => {
  for (let i = 0; i < 4; i++) {
    dbStore.appendToolLog({ t: iso(400000 + i * 1000), n: 'flaky', ok: false, src: 'mcp', session_id: `flaky-${i % 3}`, project: 'flaky_project', error_category: 'timeout', s: 'request timed out' });
  }
  for (let i = 0; i < 2; i++) {
    dbStore.appendToolLog({ t: iso(405000 + i * 1000), n: 'flaky', ok: true, src: 'mcp', session_id: `flaky-${i}`, project: 'flaky_project', s: 'ok' });
  }
  const result = predictEngine.analyze({ project: 'flaky_project' });
  const fail = result.predictions.find(p => p.type === 'likely_failure');
  assertOk(fail, 'a 67% failure rate with recent evidence is a prediction');
  assertOk(/flaky/.test(fail.subject), 'subject names the tool');
  assertOk(fail.score_breakdown.failure_rate >= 0.34, 'failure rate is recorded in the breakdown');
  assertOk(fail.score_breakdown.attempts >= 5, 'attempt count is recorded');
  assertOk(predictEngine.getPredictionEvidence(fail.id).length >= 2, 'individual failures are cited');
});

test('successful calls are never counted as failures', () => {
  for (let i = 0; i < 8; i++) {
    dbStore.appendToolLog({ t: iso(500000 + i * 1000), n: 'healthy', ok: true, src: 'mcp', session_id: `healthy-${i % 3}`, project: 'healthy_project', s: 'ok' });
  }
  const result = predictEngine.analyze({ project: 'healthy_project' });
  assertEqual(result.predictions.filter(p => p.type === 'likely_failure').length, 0,
    'an all-green tool history produces no failure predictions');
});

// --- 11: context is not a prediction ---

console.log('Predict.7: stored context is not turned into predictions');
// The test database is built from db.js's inline schema, which does not include
// the memory tables; create the real shape so this exercises the detector rather
// than an absent table.
function seedMemories() {
  const db = dbStore.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, project TEXT, content TEXT NOT NULL,
      summary TEXT, confidence REAL NOT NULL DEFAULT 0.5, enabled INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'active', times_confirmed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_handoffs (
      id TEXT PRIMARY KEY, project TEXT, title TEXT, version INTEGER DEFAULT 1, updated_at TEXT
    );
  `);
  const m = db.prepare(
    "INSERT OR REPLACE INTO memories (id, type, content, summary, project, confidence, state, enabled, times_confirmed, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)"
  );
  for (let i = 0; i < 6; i++) {
    // High confidence, recent, matching project — but no relationship to any
    // analysis target. None of this is a prediction.
    m.run(`mem-${i}`, 'note', `Some recent note ${i}`, `note ${i}`, 'ctx_project', 0.95, 5, iso(0), iso(0));
  }
  const h = db.prepare("INSERT OR REPLACE INTO memory_handoffs (id, project, title, version, updated_at) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 3; i++) h.run(`ho-${i}`, 'ctx_project', `Handoff ${i}`, 2, iso(0));
}

test('generic memories and handoffs are not dumped into predictions', () => {
  seedMemories();
  const result = predictEngine.analyze({ project: 'ctx_project' });
  assertEqual(result.predictions.filter(p => p.type === 'relevant_context').length, 0,
    'recent, high-confidence, same-project memories are still not predictions');
  const detector = result.detectors.find(d => d.name === 'relevant_context');
  assertOk(detector && detector.enabled === false, 'relevant_context is disabled by default');
});

test('even when enabled, only unresolved actionable context qualifies', () => {
  seedMemories();
  process.env.SIDEKICK_PREDICT_ENABLE_RELEVANT_CONTEXT = 'true';
  try {
    const result = predictEngine.analyze({ project: 'ctx_project' });
    const detector = result.detectors.find(d => d.name === 'relevant_context');
    assertOk(detector && detector.enabled === true, 'detector is enabled by configuration');
    assertEqual(result.predictions.filter(p => p.type === 'relevant_context').length, 0,
      'plain notes carry no unresolved condition, so nothing is emitted');

    // A genuinely unresolved blocker inside the scope does qualify.
    dbStore.getDb().prepare(
      "INSERT OR REPLACE INTO memories (id, type, content, summary, project, confidence, state, enabled, times_confirmed, created_at, updated_at) " +
      "VALUES ('mem-blocker', 'blocker', 'Migration 025 is unapplied and blocks deploys', 'unapplied migration', 'ctx_project', 0.9, 'active', 1, 3, ?, ?)"
    ).run(iso(0), iso(0));
    const second = predictEngine.analyze({ project: 'ctx_project' });
    const ctxPreds = second.predictions.filter(p => p.type === 'relevant_context');
    assertEqual(ctxPreds.length, 1, 'exactly the unresolved blocker is surfaced');
    assertOk(/unapplied/i.test(ctxPreds[0].subject), 'the blocker is the subject');
  } finally {
    delete process.env.SIDEKICK_PREDICT_ENABLE_RELEVANT_CONTEXT;
  }
});

// --- Admission gate ---

console.log('Predict.8: the admission gate rejects unsupported candidates');
test('admitCandidate enforces type, evidence, and content', () => {
  const ctx = { scope: { mode: 'project', project: 'p', session_id: null, task_id: null } };
  const base = {
    type: 'next_action', relation: 'a->b', subject: 'S', explanation: 'E',
    probability: 0.9, confidence: 'high', observation_count: 5, distinct_sessions: 3,
    time_horizon: 'current_session', recommended_action: { tool: 'b' },
    evidence: [{ summary: 'e' }], project: 'p',
  };
  assertEqual(predictEngine.admitCandidate(base, ctx).admitted, true, 'a well-formed candidate is admitted');
  assertEqual(predictEngine.admitCandidate({ ...base, type: 'nonsense' }, ctx).reason, 'unsupported_type', 'unknown type');
  assertEqual(predictEngine.admitCandidate({ ...base, subject: '  ' }, ctx).reason, 'empty_subject', 'empty subject');
  assertEqual(predictEngine.admitCandidate({ ...base, explanation: '' }, ctx).reason, 'empty_explanation', 'empty explanation');
  assertEqual(predictEngine.admitCandidate({ ...base, evidence: [] }, ctx).reason, 'insufficient_evidence', 'no evidence');
  assertEqual(predictEngine.admitCandidate({ ...base, observation_count: 1 }, ctx).reason, 'insufficient_observations', 'too few observations');
  assertEqual(predictEngine.admitCandidate({ ...base, distinct_sessions: 1 }, ctx).reason, 'insufficient_distinct_sessions', 'single session');
  assertEqual(predictEngine.admitCandidate({ ...base, confidence: 'low' }, ctx).reason, 'below_confidence_threshold', 'low confidence');
  assertEqual(predictEngine.admitCandidate({ ...base, recommended_action: null }, ctx).reason, 'not_actionable', 'no action');
  assertEqual(predictEngine.admitCandidate({ ...base, project: 'other' }, ctx).reason, 'out_of_scope_project', 'wrong project');
});

// --- 25: noisy mixed-project fixture ---

console.log('Predict.9: a noisy mixed-project fixture yields a small, defensible result');
test('noisy multi-project history produces few, in-scope predictions', () => {
  const projects = ['noise_a', 'noise_b', 'noise_c'];
  let n = 0;
  for (const proj of projects) {
    for (let s = 0; s < 4; s++) {
      for (const tool of ['read', 'write', 'search', 'deploy']) {
        dbStore.appendToolLog({
          t: iso(600000 + (n++) * 1000), n: tool, ok: n % 7 !== 0, src: 'mcp',
          session_id: `${proj}-sess-${s}`, project: proj,
          error_category: n % 7 === 0 ? 'timeout' : null, s: 'noise'
        });
      }
    }
    // Unscoped noise that must never participate in a sequence.
    for (let i = 0; i < 10; i++) {
      dbStore.appendToolLog({ t: iso(700000 + (n++) * 1000), n: 'stray', ok: true, src: 'mcp', project: proj, s: 'stray' });
    }
  }

  const result = predictEngine.analyze({ project: 'noise_a' });
  assertOk(result.ok, 'analysis ok');
  assertOk(result.created <= 5, `expected a small result set, got ${result.created}`);

  // A detector that throws is recorded rather than crashing the run, so assert
  // explicitly that none did — otherwise a broken detector looks like "no signal".
  const broken = result.detectors.filter(d => d.ok === false);
  assert.deepStrictEqual(broken, [], `detectors failed: ${JSON.stringify(broken)}`);
  assertOk(result.detectors.some(d => d.name === 'workflow_opportunity' && d.count > 0),
    'the repeated 4-tool-per-session fixture exercises the workflow detector');
  for (const p of result.predictions) {
    assertEqual(p.project, 'noise_a', 'every prediction stays inside the analyzed project');
    assertOk(p.subject && p.explanation, 'every prediction has a subject and explanation');
    assertOk(predictEngine.getPredictionEvidence(p.id).length >= 1, 'every prediction carries evidence');
  }
  const other = predictEngine.listPredictions({ project: 'noise_b', limit: 100 });
  assertEqual(other.length, 0, 'analyzing one project creates nothing for another');
});

test('a global analysis keeps identical relations from different projects distinct', () => {
  // Two projects exhibiting exactly the same tool relation.
  for (const proj of ['merge_a', 'merge_b']) {
    for (let i = 0; i < 3; i++) {
      dbStore.appendToolLog({ t: iso(800000 + i * 1000), n: 'plan', ok: true, src: 'mcp', session_id: `${proj}-m-${i}`, project: proj, s: 'p' });
      dbStore.appendToolLog({ t: iso(800000 + i * 1000 + 500), n: 'apply', ok: true, src: 'mcp', session_id: `${proj}-m-${i}`, project: proj, s: 'a' });
    }
  }
  predictEngine.analyze({ scope: 'global' });

  const planApply = predictEngine.listPredictions({ limit: 100 })
    .filter(p => p.type === 'next_action' && p.subject === 'After plan, apply commonly follows');

  const projects = planApply.map(p => p.project).sort();
  assert.deepStrictEqual(projects, ['merge_a', 'merge_b'],
    'each project keeps its own record; they are not merged into one project-null prediction');
  const identities = new Set(planApply.map(p => p.identity_key));
  assertEqual(identities.size, 2, 'the two records have distinct logical identities');
});

test('predictions from different projects are never merged into a project-null record', () => {
  const all = predictEngine.listPredictions({ limit: 100 });
  const seqTypes = ['next_action', 'missing_prerequisite', 'workflow_opportunity'];
  const orphaned = all.filter(p => seqTypes.includes(p.type) && !p.project);
  assertEqual(orphaned.length, 0, 'sequence predictions always carry their project scope');
});

// --- Listing ---

console.log('Predict.10: listing and filtering');
test('listPredictions filters', () => {
  assertOk(Array.isArray(predictEngine.listPredictions({})), 'default returns array');
  assertOk(Array.isArray(predictEngine.listPredictions({ status: 'active' })), 'status filter');
  assertOk(Array.isArray(predictEngine.listPredictions({ type: 'next_action' })), 'type filter');
  assertOk(Array.isArray(predictEngine.listPredictions({ confidence: 'high' })), 'confidence filter');
  assertEqual(predictEngine.listPredictions({ limit: 1 }).length <= 1, true, 'limit respected');
});

test('getPrediction returns null for an unknown id', () => {
  assertEqual(predictEngine.getPrediction('nonexistent'), null, 'returns null');
});

test('every persisted prediction uses a supported type', () => {
  const all = predictEngine.listPredictions({ limit: 100 });
  for (const p of all) {
    assertOk(predictEngine.VALID_TYPES.includes(p.type), `unsupported type persisted: ${p.type}`);
  }
});

console.log('\nPredict tests: ' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
