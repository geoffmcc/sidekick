/**
 * Predict API contract test.
 *
 * Guards the one canonical contract documented in docs/predict.md: the dashboard
 * frontend must read only field names the backend actually returns, and its type
 * labels must match the backend prediction enum.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-predict-contract');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/predict')];
const predictEngine = require('../src/predict');

const ROOT = path.join(__dirname, '..');
const frontend = fs.readFileSync(path.join(ROOT, 'static', 'dashboard.js'), 'utf-8');
const markup = fs.readFileSync(path.join(ROOT, 'src', 'dashboard.html'), 'utf-8');
const server = fs.readFileSync(path.join(ROOT, 'src', 'dashboard.js'), 'utf-8');

console.log('Running Predict Contract Tests...\n');

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

console.log('Contract.1: prediction type labels match the backend enum');
test('frontend PREDICT_TYPE_LABELS matches VALID_TYPES exactly', () => {
  const block = frontend.match(/const PREDICT_TYPE_LABELS = \{([\s\S]*?)\};/);
  assert.ok(block, 'PREDICT_TYPE_LABELS is defined in static/dashboard.js');
  const keys = [...block[1].matchAll(/(\w+)\s*:/g)].map(m => m[1]);
  assert.ok(keys.length > 0, 'labels parsed');

  const backend = predictEngine.VALID_TYPES.slice().sort();
  assert.deepStrictEqual(keys.slice().sort(), backend,
    `frontend labels ${JSON.stringify(keys.sort())} must equal backend enum ${JSON.stringify(backend)}`);
});

test('the type filter dropdown offers only real backend types', () => {
  const select = markup.match(/id="predictTypeFilter"[\s\S]*?<\/select>/);
  assert.ok(select, 'predictTypeFilter exists');
  const values = [...select[0].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
  assert.ok(values.length > 0, 'filter has options');
  for (const v of values) {
    assert.ok(predictEngine.VALID_TYPES.includes(v),
      `filter option "${v}" is not a backend prediction type`);
  }
});

console.log('Contract.2: the status panel reads fields the backend returns');
test('every status field the frontend reads exists in engineStatus()', () => {
  const status = predictEngine.engineStatus();
  // Fields loadPredictStatus() reads off the /api/predict/status response.
  const required = [
    'active', 'terminal', 'total', 'detectors',
    'last_analyzed', 'last_analysis_scope', 'last_analysis_summary', 'retention_days',
  ];
  for (const field of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(status, field),
      `engineStatus() is missing "${field}" which the dashboard renders`);
    assert.ok(frontend.includes('d.' + field),
      `static/dashboard.js does not read "${field}"`);
  }
  assert.ok(typeof status.retention_days === 'number', 'retention_days is a real configured number');
  assert.ok(Array.isArray(status.detectors), 'detectors is an array');
  assert.ok(status.detectors.every(d => typeof d.name === 'string' && typeof d.enabled === 'boolean'),
    'each detector reports a name and enabled flag');
});

test('the dashboard does not display a fabricated retention value', () => {
  assert.ok(!/retention_days \|\| 30/.test(frontend),
    'a hardcoded 30-day retention fallback must not be displayed');
});

test('documented aliases stay in sync with canonical counts', () => {
  const s = predictEngine.engineStatus();
  assert.strictEqual(s.active_predictions, s.active, 'active_predictions aliases active');
  assert.strictEqual(s.total_predictions, s.total, 'total_predictions aliases total');
  assert.strictEqual(s.last_analysis, s.last_analyzed, 'last_analysis aliases last_analyzed');
});

console.log('Contract.3: the Analyze button submits an explicit scope');
test('the frontend never posts an empty analyze body', () => {
  const fn = frontend.match(/function runPredictAnalyze\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'runPredictAnalyze is defined');
  assert.ok(!/JSON\.stringify\(\{\}\)/.test(fn[0]),
    'an empty {} body would trigger an unscoped all-project analysis');
  assert.ok(/predictAnalyzeBody\(\)/.test(fn[0]), 'the request body is built from the scope selector');
  assert.ok(/scope/.test(frontend.match(/function predictAnalyzeBody\(\)[\s\S]*?\n\}/)[0]),
    'the body carries an explicit scope');
});

test('the scope selector exists and offers an explicit global option', () => {
  assert.ok(/id="predictScope"/.test(markup), 'a scope selector is present');
  assert.ok(/value="global"/.test(markup), 'global analysis is an explicit choice');
  assert.ok(/Analysis complete/.test(frontend), 'the analyze result reports what changed');
});

console.log('Contract.4: server routes enforce scope and confirmation');
test('the analyze route rejects an unscoped request', () => {
  assert.ok(/if \(!result\.ok\) return res\.status\(400\)\.json\(result\);/.test(server),
    'the analyze route surfaces a scope error as a 400');
  const result = predictEngine.analyze({});
  assert.strictEqual(result.ok, false, 'the engine refuses an unscoped analysis');
});

test('the purge route requires explicit confirmation', () => {
  assert.ok(/predictEngine\.purge\(\{\s*confirm:\s*confirm === true/.test(server),
    'the purge route only confirms on a literal true');
  assert.strictEqual(predictEngine.purge({}).ok, false, 'unconfirmed purge is refused');
  assert.strictEqual(predictEngine.purge({ confirm: 'true' }).ok, false, 'a truthy string does not confirm');
});

test('purge_preview is exposed as a read-only GET', () => {
  assert.ok(/app\.get\("\/api\/predict\/maintenance\/purge-preview"/.test(server),
    'preview is a GET route');
  assert.ok(/app\.post\("\/api\/predict\/maintenance\/purge"/.test(server),
    'purge is a POST route');
});

console.log('Contract.5: the MCP tool surface stays compatible');
test('canonical tool actions are preserved and extended', () => {
  const legacy = fs.readFileSync(path.join(ROOT, 'src', 'tools-legacy.js'), 'utf-8');
  const schemas = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'schemas', 'index.js'), 'utf-8');
  const match = legacy.match(/const validActions = \[([^\]]*)\]/);
  assert.ok(match, 'validActions found');
  const actions = [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  for (const existing of ['analyze', 'list', 'get', 'feedback', 'outcome', 'dismiss', 'explain', 'status', 'suggest', 'migrate']) {
    assert.ok(actions.includes(existing), `existing action "${existing}" must be preserved`);
  }
  for (const added of ['purge_preview', 'purge', 'diagnose']) {
    assert.ok(actions.includes(added), `new action "${added}" is dispatchable`);
    assert.ok(schemas.includes(`"${added}"`), `new action "${added}" is in the zod schema`);
  }
});

test('every documented purge option is reachable through the tool and the route', () => {
  const legacy = fs.readFileSync(path.join(ROOT, 'src', 'tools-legacy.js'), 'utf-8');
  const schemas = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'schemas', 'index.js'), 'utf-8');
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'predict.md'), 'utf-8');

  for (const opt of ['retention_days', 'purge_legacy', 'confirm']) {
    assert.ok(schemas.includes(`${opt}:`), `"${opt}" is declared in the predict zod schema`);
    assert.ok(legacy.includes(opt), `"${opt}" is forwarded by the MCP dispatcher`);
    assert.ok(server.includes(opt), `"${opt}" is forwarded by the dashboard route`);
    assert.ok(docs.includes(opt), `"${opt}" is documented`);
  }
});

console.log('\nPredict Contract tests: ' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
