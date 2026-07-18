// Phase 4 — worker re-enrollment (credential recovery via scoped token).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-compute-reenroll');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = 'sk-sidekick-test-key';

delete require.cache[require.resolve('../src/db')];
const workerManager = require('../src/compute/worker-manager');
const { EnrollmentError } = require('../src/compute/errors');

console.log('Running Compute Re-enrollment Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${e.stack || e.message}`); }
}

let nodeSeq = 0;
function enroll(nodeId, tokenOpts) {
  const tok = workerManager.createEnrollmentToken({ displayName: nodeId, expiresInMs: 600000, ...(tokenOpts || {}) });
  return workerManager.enrollWorker({ nodeId, displayName: nodeId, platform: 'linux', enrollmentToken: tok.token });
}

test('createEnrollmentToken stores and returns reEnrollmentOf', () => {
  const tok = workerManager.createEnrollmentToken({ displayName: 't', expiresInMs: 600000, reEnrollmentOf: 'node_x' });
  assert.strictEqual(tok.reEnrollmentOf, 'node_x');
});

test('fresh enroll reports reEnrolled=false', () => {
  const r = enroll(`reenroll-node-${++nodeSeq}`);
  assert.strictEqual(r.reEnrolled, false);
  assert.ok(r.credential);
});

test('re-enroll of an active node without a scoped token is rejected', () => {
  const nodeId = `reenroll-node-${++nodeSeq}`;
  enroll(nodeId);
  assert.throws(() => enroll(nodeId), EnrollmentError);
  assert.throws(() => enroll(nodeId), /already enrolled/);
});

test('re-enroll with a node-scoped token recovers identity and rotates credential', () => {
  const nodeId = `reenroll-node-${++nodeSeq}`;
  const first = enroll(nodeId);
  const oldCredential = first.credential;
  // Scoped re-enrollment token for this node.
  const r = enroll(nodeId, { reEnrollmentOf: nodeId });
  assert.strictEqual(r.reEnrolled, true, 'flagged as re-enrollment');
  assert.strictEqual(r.worker.workerId, first.worker.workerId, 'same worker identity reused');
  assert.strictEqual(r.replacedWorkerId, first.worker.workerId);
  assert.notStrictEqual(r.credential, oldCredential, 'new credential issued');
  // Old credential no longer authenticates; new one does.
  assert.strictEqual(workerManager.authenticateWorker(first.worker.workerId, oldCredential), null, 'old credential invalidated');
  assert.ok(workerManager.authenticateWorker(r.worker.workerId, r.credential), 'new credential authenticates');
  assert.strictEqual(workerManager.getWorker(r.worker.workerId).credentialState, 'active');
});

test('re-enroll of a revoked node is allowed with a normal token and un-revokes it', () => {
  const nodeId = `reenroll-node-${++nodeSeq}`;
  const first = enroll(nodeId);
  workerManager.revokeWorker(first.worker.workerId, 'test');
  assert.strictEqual(workerManager.getWorker(first.worker.workerId).credentialState, 'revoked');
  const r = enroll(nodeId); // normal token; allowed because node is revoked/retired
  assert.strictEqual(r.reEnrolled, true);
  assert.strictEqual(r.worker.workerId, first.worker.workerId);
  const w = workerManager.getWorker(r.worker.workerId);
  assert.strictEqual(w.credentialState, 'active', 'un-revoked');
  assert.strictEqual(w.state, 'online');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
