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

console.log('Predict.1: engineStatus returns correct shape');
test('engineStatus shape', () => {
  const s = predictEngine.engineStatus();
  assertOk(s.ok === true, 'ok is true');
  assertOk(s.rules, 'has rules');
  assertOk(Array.isArray(s.rules), 'rules is array');
  assertOk(s.rules.length > 0, 'has at least one rule');
  assertEqual(s.active_predictions, 0, 'active_predictions is 0 initially');
  assertEqual(s.total_predictions, 0, 'total_predictions is 0 initially');
  assertOk(typeof s.total_evidence === 'number', 'total_evidence is number');
  assertOk(Array.isArray(s.type_breakdown), 'type_breakdown is array');
  assertOk(Array.isArray(s.confidence_breakdown), 'confidence_breakdown is array');
  const r = s.rules[0];
  assertOk(r.rule_version, 'rule has rule_version');
  assertOk(r.name, 'rule has name');
});

console.log('Predict.2: analyze produces predictions from empty data');
test('analyze empty data', () => {
  const result = predictEngine.analyze({});
  assertOk(result.ok === true, 'result.ok is true');
  assertOk(typeof result.created === 'number', 'result has created count');
  assertOk(typeof result.duration_ms === 'number', 'result has duration_ms');
  assertOk(Array.isArray(result.predictions), 'predictions is array');
  assertOk(Array.isArray(result.detectors), 'detectors is array');
  assertEqual(result.predictions.length, 0, 'insufficient evidence produces no predictions');
});

console.log('Predict.2b: analyze produces useful next-action prediction from tool history');
test('analyze deterministic next action', () => {
  for (let i = 0; i < 3; i++) {
    dbStore.appendToolLog({ t: new Date(Date.now() + i * 1000).toISOString(), n: 'knowledge', ok: true, src: 'mcp', session_id: `predict-session-${i}`, project: 'predict_project', s: 'searched docs' });
    dbStore.appendToolLog({ t: new Date(Date.now() + i * 1000 + 500).toISOString(), n: 'tools', ok: true, src: 'mcp', session_id: `predict-session-${i}`, project: 'predict_project', s: 'inspected tool catalog' });
  }
  const result = predictEngine.analyze({ project: 'predict_project' });
  assertOk(result.ok === true, 'analysis ok');
  assertOk(result.predictions.length >= 1, 'created at least one prediction');
  const next = result.predictions.find(p => p.type === 'next_action');
  assertOk(next, 'has next_action prediction');
  assertOk(next.subject.includes('knowledge') && next.subject.includes('tools'), 'prediction is grounded in expected sequence');
  assertEqual(next.confidence, 'medium', 'three observations produce medium confidence');
  assertOk(next.observation_count >= 3, 'observation count recorded');
  const evidence = predictEngine.getPredictionEvidence(next.id);
  assertOk(evidence.length >= 1, 'evidence stored');
  const duplicate = predictEngine.analyze({ project: 'predict_project' });
  assertEqual(duplicate.created, 0, 'duplicate analysis is suppressed');
});

console.log('Predict.3: listPredictions returns array');
test('listPredictions', () => {
  const preds = predictEngine.listPredictions({});
  assertOk(Array.isArray(preds), 'returns array');
});

console.log('Predict.4: getPrediction returns null for unknown ID');
test('getPrediction unknown', () => {
  const p = predictEngine.getPrediction('nonexistent');
  assertEqual(p, null, 'returns null for unknown ID');
});

console.log('Predict.5: scoring engine produces valid values');
test('scoring engine', () => {
  const s = predictEngine.engineStatus();
  assertOk(typeof s.total_predictions === 'number', 'total_predictions is number');
  assertOk(typeof s.active_predictions === 'number', 'active_predictions is number');
});

console.log('Predict.6: listPredictions with status filter works');
test('listPredictions filter', () => {
  const all = predictEngine.listPredictions({});
  const active = predictEngine.listPredictions({ status: 'active' });
  assertOk(Array.isArray(all), 'all is array');
  assertOk(Array.isArray(active), 'active filter is array');
});

console.log('Predict.7: listPredictions with type filter works');
test('listPredictions type filter', () => {
  const preds = predictEngine.listPredictions({ type: 'likely_next_action' });
  assertOk(Array.isArray(preds), 'type filter returns array');
});

console.log('Predict.8: listPredictions with confidence filter works');
test('listPredictions confidence filter', () => {
  const preds = predictEngine.listPredictions({ confidence: 'high' });
  assertOk(Array.isArray(preds), 'confidence filter returns array');
});

console.log('\nPredict tests: ' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
