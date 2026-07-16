const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-predict-lifecycle');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/predict')];
const dbStore = require('../src/db');
const predictEngine = require('../src/predict');

console.log('Running Predict Lifecycle Tests...\n');

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
function assertOk(val, msg) {
  assert.ok(val, msg || `expected truthy, got ${val}`);
}

for (let i = 0; i < 3; i++) {
  dbStore.appendToolLog({ t: new Date(Date.now() + i * 1000).toISOString(), n: 'knowledge', ok: true, src: 'mcp', session_id: `predict-lifecycle-seq-${i}`, project: 'predict_lifecycle', s: 'searched docs' });
  dbStore.appendToolLog({ t: new Date(Date.now() + i * 1000 + 500).toISOString(), n: 'tools', ok: true, src: 'mcp', session_id: `predict-lifecycle-seq-${i}`, project: 'predict_lifecycle', s: 'inspected tool catalog' });
}
for (let i = 0; i < 2; i++) {
  dbStore.appendToolLog({ t: new Date(Date.now() + 10_000 + i * 1000).toISOString(), n: 'web_fetch', ok: false, src: 'mcp', session_id: `predict-lifecycle-fail-${i}`, project: 'predict_lifecycle', error_category: 'timeout', s: 'request timed out' });
}

// Run an analyze to populate predictions
const analysisResult = predictEngine.analyze({ project: 'predict_lifecycle' });
const testPredictions = analysisResult.predictions || [];
console.log(`  (Analyze produced ${testPredictions.length} predictions for lifecycle tests)\n`);

console.log('LC.1: analyze produces predictions with valid IDs');
test('analyze produces IDs', () => {
  assert.ok(testPredictions.length >= 2, 'fixture produces at least two predictions');
  assert.ok(testPredictions[0].id, 'first prediction has id');
  assert.ok(testPredictions[0].id.startsWith('pred_'), 'id starts with pred_');
});

console.log('LC.2: getPrediction returns prediction after analyze');
test('getPrediction after analyze', () => {
  const p = predictEngine.getPrediction(testPredictions[0].id);
  assert.ok(p, 'prediction found');
  assert.equal(p.id, testPredictions[0].id, 'id matches');
});

console.log('LC.3: recordFeedback stores feedback');
test('recordFeedback', () => {
  const id = testPredictions[0].id;
  const result = predictEngine.recordFeedback(id, 'useful');
  assert.ok(result.ok, 'feedback ok');
  const fb = predictEngine.getPredictionFeedback(id);
  assert.ok(fb.length > 0, 'feedback stored');
  assert.equal(fb[0].feedback, 'useful', 'feedback value matches');
});

console.log('LC.4: recordOutcome updates status');
test('recordOutcome', () => {
  const id = testPredictions[0].id;
  const result = predictEngine.recordOutcome(id, 'confirmed');
  assert.ok(result.ok, 'outcome ok');
  const p = predictEngine.getPrediction(id);
  assert.equal(p.status, 'confirmed', 'status updated to confirmed');
});

console.log('LC.5: dismissPrediction sets dismissed status');
test('dismissPrediction', () => {
  const id = testPredictions[1].id;
  const result = predictEngine.dismissPrediction(id);
  assert.ok(result.ok, 'dismiss ok');
  const p = predictEngine.getPrediction(id);
  assert.equal(p.status, 'dismissed', 'status updated to dismissed');
});

console.log('LC.6: listPredictions respects limit');
test('listPredictions limit', () => {
  const preds = predictEngine.listPredictions({ limit: 2 });
  assert.ok(preds.length <= 2, 'limit respected');
});

console.log('LC.7: getPredictionEvidence returns array');
test('getPredictionEvidence', () => {
  const ev = predictEngine.getPredictionEvidence(testPredictions[0].id);
  assert.ok(Array.isArray(ev), 'returns array');
  assert.ok(ev.length > 0, 'evidence stored');
});

console.log('LC.8: migrateLegacy is idempotent');
test('migrateLegacy idempotent', () => {
  const r1 = predictEngine.migrateLegacy();
  assert.ok(typeof r1.migrated === 'number', 'first call returns migrated count');
  const r2 = predictEngine.migrateLegacy();
  assert.ok(typeof r2.migrated === 'number', 'second call returns migrated count');
});

console.log('LC.9: engineStatus reflects populated data');
test('engineStatus after populate', () => {
  const s = predictEngine.engineStatus();
  assertOk(typeof s.total_predictions === 'number', 'total_predictions is number');
  assertOk(typeof s.active_predictions === 'number', 'active_predictions is number');
  assertOk(s.rules.length === 1, 'one rule present');
});

console.log('LC.10: dismiss on nonexistent ID returns error');
test('dismiss nonexistent', () => {
  const result = predictEngine.dismissPrediction('nonexistent_id');
  assert.ok(result.ok === false || result.error, 'returns error for unknown ID');
});

console.log('\nPredict Lifecycle tests: ' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
