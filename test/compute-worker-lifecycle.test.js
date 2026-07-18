// Phase 1 — multi-dimensional worker lifecycle state model.
// Exercises the orthogonal connection/admin/credential dimensions, the derived
// legacy `state` column, periodic reconciliation, and graceful disconnect.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-compute-lifecycle');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = 'sk-sidekick-test-key';

delete require.cache[require.resolve('../src/db')];
const dbStore = require('../src/db');
const workerManager = require('../src/compute/worker-manager');
const { WorkerRevokedError } = require('../src/compute/errors');

console.log('Running Compute Worker Lifecycle Tests...\n');

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
    console.log(`    ${e.stack || e.message}`);
  }
}

let nodeSeq = 0;
function enrollFresh(displayName) {
  const tok = workerManager.createEnrollmentToken({ displayName, expiresInMs: 600000 });
  return workerManager.enrollWorker({
    nodeId: `lifecycle-node-${++nodeSeq}`,
    displayName,
    platform: 'linux',
    enrollmentToken: tok.token,
  });
}

function setHeartbeat(workerId, iso) {
  dbStore.getDb().prepare('UPDATE compute_workers SET last_heartbeat = ? WHERE worker_id = ?').run(iso, workerId);
}

// --- Enrollment establishes coherent dimensions ---
test('enroll yields online connection with enabled/active dimensions', () => {
  const w = enrollFresh('enroll-dims');
  const worker = workerManager.getWorker(w.workerId);
  assert.strictEqual(worker.state, 'online', 'legacy state online');
  assert.strictEqual(worker.connectionState, 'online');
  assert.strictEqual(worker.adminState, 'enabled');
  assert.strictEqual(worker.credentialState, 'active');
});

// --- Heartbeat reconnects an offline worker ---
test('heartbeat brings an offline connection back online', () => {
  const w = enrollFresh('hb-reconnect');
  workerManager.disconnectWorker(w.workerId, 'test');
  assert.strictEqual(workerManager.getWorker(w.workerId).connectionState, 'offline', 'offline after disconnect');
  const after = workerManager.heartbeat(w.workerId, { currentJobs: 0 });
  assert.strictEqual(after.connectionState, 'online', 'reconnected');
  assert.strictEqual(after.state, 'online', 'derived legacy state online');
});

// --- Reconciliation marks stale online workers offline ---
test('reconcileWorkerStates marks stale online worker offline', () => {
  const w = enrollFresh('recon-stale');
  setHeartbeat(w.workerId, new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const ids = workerManager.reconcileWorkerStates(90000);
  assert.ok(ids.includes(w.workerId), 'stale worker returned');
  const worker = workerManager.getWorker(w.workerId);
  assert.strictEqual(worker.connectionState, 'offline');
  assert.strictEqual(worker.state, 'offline');
  assert.strictEqual(worker.lastDisconnectReason, 'missed_heartbeat');
  assert.ok(worker.disconnectedAt, 'disconnectedAt recorded');
});

test('reconcileWorkerStates leaves a fresh heartbeat online', () => {
  const w = enrollFresh('recon-fresh');
  setHeartbeat(w.workerId, new Date().toISOString());
  workerManager.reconcileWorkerStates(90000);
  assert.strictEqual(workerManager.getWorker(w.workerId).connectionState, 'online');
});

// --- Reconciliation respects maintenance ---
test('reconcile keeps admin_state=maintenance while dropping connection', () => {
  const w = enrollFresh('recon-maint');
  workerManager.updateWorker(w.workerId, { adminState: 'maintenance' });
  setHeartbeat(w.workerId, new Date(Date.now() - 10 * 60 * 1000).toISOString());
  workerManager.reconcileWorkerStates(90000);
  const worker = workerManager.getWorker(w.workerId);
  assert.strictEqual(worker.connectionState, 'offline', 'connection dropped');
  assert.strictEqual(worker.adminState, 'maintenance', 'admin preserved');
  assert.strictEqual(worker.state, 'maintenance', 'derived legacy state stays maintenance');
});

// --- Reconciliation never touches revoked ---
test('reconcile does not resurrect or alter a revoked worker', () => {
  const w = enrollFresh('recon-revoked');
  workerManager.revokeWorker(w.workerId, 'test_revoke');
  setHeartbeat(w.workerId, new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const ids = workerManager.reconcileWorkerStates(90000);
  assert.ok(!ids.includes(w.workerId), 'revoked worker not in reconcile set');
  assert.strictEqual(workerManager.getWorker(w.workerId).state, 'revoked');
});

// --- Graceful disconnect ---
test('disconnectWorker drops connection and records reason, preserving admin', () => {
  const w = enrollFresh('disc-graceful');
  workerManager.updateWorker(w.workerId, { adminState: 'maintenance' });
  const worker = workerManager.disconnectWorker(w.workerId, 'sigterm');
  assert.strictEqual(worker.connectionState, 'offline');
  assert.strictEqual(worker.adminState, 'maintenance', 'admin preserved through disconnect');
  assert.strictEqual(worker.state, 'maintenance');
  assert.strictEqual(worker.lastDisconnectReason, 'sigterm');
});

// --- Admin enable/disable coherence ---
test('disable sets maintenance across dimensions and flag', () => {
  const w = enrollFresh('admin-disable');
  const worker = workerManager.updateWorker(w.workerId, { adminState: 'maintenance' });
  assert.strictEqual(worker.adminState, 'maintenance');
  assert.strictEqual(worker.maintenanceMode, true, 'legacy maintenanceMode flag synced');
  assert.strictEqual(worker.state, 'maintenance');
});

test('enable reflects real connection, does not force offline or online', () => {
  const w = enrollFresh('admin-enable');
  // Online worker: disable then enable returns it to online (still connected).
  workerManager.updateWorker(w.workerId, { adminState: 'maintenance' });
  const online = workerManager.updateWorker(w.workerId, { adminState: 'enabled' });
  assert.strictEqual(online.state, 'online', 'enable on connected worker -> online');
  assert.strictEqual(online.maintenanceMode, false);
  // Disconnected worker: enable leaves it offline (does not force online).
  workerManager.disconnectWorker(w.workerId, 'test');
  const offline = workerManager.updateWorker(w.workerId, { adminState: 'enabled' });
  assert.strictEqual(offline.state, 'offline', 'enable on disconnected worker stays offline');
});

test('legacy maintenanceMode flag still drives admin_state coherently', () => {
  const w = enrollFresh('legacy-flag');
  const off = workerManager.updateWorker(w.workerId, { maintenanceMode: true });
  assert.strictEqual(off.adminState, 'maintenance', 'flag true -> admin maintenance');
  assert.strictEqual(off.state, 'maintenance');
  const on = workerManager.updateWorker(w.workerId, { maintenanceMode: false });
  assert.strictEqual(on.adminState, 'enabled', 'flag false -> admin enabled');
});

// --- Revocation is terminal ---
test('revoke sets credential_state and blocks authentication', () => {
  const enrolled = enrollFresh('revoke-auth');
  assert.ok(workerManager.authenticateWorker(enrolled.workerId, enrolled.credential), 'authenticates before revoke');
  workerManager.revokeWorker(enrolled.workerId, 'test');
  const worker = workerManager.getWorker(enrolled.workerId);
  assert.strictEqual(worker.credentialState, 'revoked');
  assert.strictEqual(worker.state, 'revoked');
  assert.strictEqual(workerManager.authenticateWorker(enrolled.workerId, enrolled.credential), null, 'auth blocked after revoke');
});

test('heartbeat on revoked worker throws WorkerRevokedError', () => {
  const w = enrollFresh('revoke-hb');
  workerManager.revokeWorker(w.workerId, 'test');
  assert.throws(() => workerManager.heartbeat(w.workerId, { currentJobs: 0 }), WorkerRevokedError);
});

test('enable cannot undo revocation', () => {
  const w = enrollFresh('revoke-enable');
  workerManager.revokeWorker(w.workerId, 'test');
  const worker = workerManager.updateWorker(w.workerId, { adminState: 'enabled' });
  assert.strictEqual(worker.state, 'revoked', 'still revoked after enable');
  assert.strictEqual(worker.credentialState, 'revoked');
});

// --- deriveLegacyState precedence ---
test('deriveLegacyState precedence: revoked > maintenance > draining > online > offline', () => {
  const d = workerManager.deriveLegacyState;
  assert.strictEqual(d('online', 'enabled', 'revoked'), 'revoked');
  assert.strictEqual(d('online', 'maintenance', 'active'), 'maintenance');
  assert.strictEqual(d('online', 'draining', 'active'), 'draining');
  assert.strictEqual(d('online', 'enabled', 'active'), 'online');
  assert.strictEqual(d('offline', 'enabled', 'active'), 'offline');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
