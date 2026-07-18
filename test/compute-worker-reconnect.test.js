// Phase 6 — reconnection policy: outcome classification + backoff bounds.
const assert = require('assert');
const rc = require('../src/compute/worker-reconnect');

console.log('Running Compute Worker Reconnect Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${e.stack || e.message}`); }
}

// --- classifyStatus ---
test('2xx is ok', () => {
  assert.strictEqual(rc.classifyStatus(200), rc.OK);
  assert.strictEqual(rc.classifyStatus(204), rc.OK);
});
test('401/403 while enrolled are permanent', () => {
  assert.strictEqual(rc.classifyStatus(401, { enrolled: true }), rc.PERMANENT);
  assert.strictEqual(rc.classifyStatus(403, { enrolled: true }), rc.PERMANENT);
});
test('401 while NOT enrolled is transient (token exchange may be racing)', () => {
  assert.strictEqual(rc.classifyStatus(401, { enrolled: false }), rc.TRANSIENT);
});
test('426 protocol-incompatible is permanent', () => {
  assert.strictEqual(rc.classifyStatus(426), rc.PERMANENT);
});
test('408/429/5xx are transient', () => {
  for (const s of [408, 429, 500, 502, 503, 504]) assert.strictEqual(rc.classifyStatus(s), rc.TRANSIENT, `status ${s}`);
});
test('unexpected 4xx stays transient (conservative)', () => {
  for (const s of [400, 404, 409]) assert.strictEqual(rc.classifyStatus(s), rc.TRANSIENT, `status ${s}`);
});
test('thrown request errors are always transient', () => {
  assert.strictEqual(rc.classifyError(new Error('ECONNREFUSED')), rc.TRANSIENT);
});

// --- nextBackoff ---
test('nextBackoff grows exponentially within jitter bounds', () => {
  for (let attempt = 0; attempt <= 4; attempt++) {
    const base = 1000 * Math.pow(2, attempt);
    for (let i = 0; i < 200; i++) {
      const d = rc.nextBackoff(attempt, { baseMs: 1000, maxMs: 60000 });
      assert.ok(d >= base, `attempt ${attempt}: ${d} >= ${base}`);
      assert.ok(d < base + base * 0.2 + 1, `attempt ${attempt}: ${d} < ${base * 1.2}`);
    }
  }
});
test('nextBackoff is capped at maxMs', () => {
  for (let i = 0; i < 200; i++) {
    const d = rc.nextBackoff(20, { baseMs: 1000, maxMs: 30000 });
    assert.strictEqual(d, 30000, `capped at maxMs, got ${d}`);
  }
});
test('nextBackoff tolerates a zero/negative attempt', () => {
  const d = rc.nextBackoff(0, { baseMs: 2000, maxMs: 30000 });
  assert.ok(d >= 2000 && d < 2400);
  assert.ok(rc.nextBackoff(-5, { baseMs: 2000, maxMs: 30000 }) >= 2000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
