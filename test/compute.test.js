const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-compute');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = 'sk-sidekick-test-key';

delete require.cache[require.resolve('../src/db')];
const dbStore = require('../src/db');
const compute = require('../src/compute');
const providerRegistry = require('../src/compute/provider-registry');
const modelRegistry = require('../src/compute/model-registry');
const jobManager = require('../src/compute/job-manager');
const workerManager = require('../src/compute/worker-manager');
const executorRegistry = require('../src/compute/executor-registry');
const inferenceService = require('../src/compute/inference-service');
const healthMonitor = require('../src/compute/health-monitor');
const { ComputeError, EmptyProviderResultError, ResultValidationError } = require('../src/compute/errors');
const { MockProvider } = require('../src/providers/mock-provider');
const { validateJobResult } = require('../src/compute/worker-agent');

console.log('Running Compute Tests...\n');

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
async function testAsync(name, fn) {
  try {
    await fn();
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
function assertIncludes(arr, val, msg) {
  assert.ok(Array.isArray(arr) && arr.includes(val), msg || `expected array to include ${val}`);
}

// ─── 1. Error types ───
console.log('Compute.1: error types');
test('ComputeError is proper Error subclass', () => {
  const e = new ComputeError('test', 'TEST_CODE', { detail: 42 });
  assertOk(e instanceof Error, 'is Error');
  assertEqual(e.code, 'TEST_CODE');
  assertEqual(e.message, 'test');
  assertEqual(e.details.detail, 42);
});

// ─── 1b. New error types ───
console.log('Compute.1b: new error types');
test('EmptyProviderResultError has correct code and message', () => {
  const e = new EmptyProviderResultError('ollama', { modelId: 'llama3' });
  assertOk(e instanceof Error, 'is Error');
  assertEqual(e.code, 'EMPTY_PROVIDER_RESULT');
  assertOk(e.message.includes('ollama'), 'mentions provider');
  assertEqual(e.details.modelId, 'llama3');
});

test('ResultValidationError has correct code and message', () => {
  const e = new ResultValidationError('content too large', { size: 99999 });
  assertOk(e instanceof Error, 'is Error');
  assertEqual(e.code, 'RESULT_VALIDATION_FAILED');
  assertOk(e.message.includes('content too large'), 'includes reason');
  assertEqual(e.details.size, 99999);
});

// ─── 1c. validateJobResult ───
console.log('Compute.1c: validateJobResult');
test('valid content passes validation', () => {
  assertEqual(validateJobResult({ content: 'Hello world', model: 'llama3', provider: 'ollama' }), null);
});

test('valid embedding passes validation', () => {
  assertEqual(validateJobResult({ embedding: [0.1, -0.2, 0.3] }), null);
});

test('null result fails validation', () => {
  const err = validateJobResult(null);
  assertOk(err, 'returns error');
  assertEqual(err.category, 'RESULT_VALIDATION_FAILED');
  assertOk(err.message.includes('non-object'), 'mentions non-object');
});

test('undefined result fails validation', () => {
  const err = validateJobResult(undefined);
  assertOk(err, 'returns error');
  assertEqual(err.category, 'RESULT_VALIDATION_FAILED');
});

test('empty string content fails validation', () => {
  const err = validateJobResult({ content: '' });
  assertOk(err, 'returns error');
  assertEqual(err.category, 'EMPTY_PROVIDER_RESULT');
});

test('whitespace-only content fails validation', () => {
  const err = validateJobResult({ content: '   \n\t  ' });
  assertOk(err, 'returns error');
  assertEqual(err.category, 'EMPTY_PROVIDER_RESULT');
});

test('thinking-only response without content fails validation', () => {
  const err = validateJobResult({ thinking: 'reasoning here' });
  assertOk(err, 'returns error');
  assertEqual(err.category, 'EMPTY_PROVIDER_RESULT');
  assertOk(err.message.includes('no content or embedding'), 'correct message');
});

test('non-string non-array content fails validation', () => {
  const err = validateJobResult({ content: 12345 });
  assertOk(err, 'returns error');
  assertEqual(err.category, 'EMPTY_PROVIDER_RESULT');
});

test('object-only result with no content or embedding fails', () => {
  const err = validateJobResult({ model: 'llama3', provider: 'ollama' });
  assertOk(err, 'returns error');
  assertEqual(err.category, 'EMPTY_PROVIDER_RESULT');
});

test('content exceeding 10MB fails validation', () => {
  const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
  const err = validateJobResult({ content: huge });
  assertOk(err, 'returns error');
  assertEqual(err.category, 'RESULT_VALIDATION_FAILED');
  assertOk(err.message.includes('exceeds maximum size'), 'mentions size limit');
});

test('content at exactly 10MB passes validation', () => {
  const exact = 'x'.repeat(10 * 1024 * 1024);
  assertEqual(validateJobResult({ content: exact }), null);
});

test('result with both content and embedding passes', () => {
  assertEqual(validateJobResult({ content: 'text', embedding: [0.1] }), null);
});

// ─── 2. ProviderRegistry ───
console.log('Compute.2: ProviderRegistry');
test('createProvider stores and returns provider', () => {
  providerRegistry.ensureSchema();
  const p = providerRegistry.createProvider({
    displayName: 'test-ollama',
    providerType: 'ollama',
    endpoint: 'http://localhost:11434',
    priority: 10
  });
  assertOk(p.providerId, 'has providerId');
  assertEqual(p.displayName, 'test-ollama');
  assertEqual(p.providerType, 'ollama');
  assertEqual(p.priority, 10);
  assertEqual(p.enabled, true);
  assertEqual(p.health.status, 'unknown');
});

test('listProviders returns providers', () => {
  const list = providerRegistry.listProviders();
  assertOk(Array.isArray(list), 'is array');
  assertOk(list.length >= 1, 'has at least 1');
});

test('getProvider by id', () => {
  const list = providerRegistry.listProviders();
  const found = providerRegistry.getProvider(list[0].providerId);
  assertOk(found, 'found');
  assertEqual(found.displayName, 'test-ollama');
});

test('updateProvider changes fields', () => {
  const list = providerRegistry.listProviders();
  const updated = providerRegistry.updateProvider(list[0].providerId, { priority: 99 });
  assertEqual(updated.priority, 99);
});

test('deleteProvider removes provider', () => {
  const p = providerRegistry.createProvider({ displayName: 'temp', providerType: 'mock', endpoint: 'http://x' });
  const deleted = providerRegistry.deleteProvider(p.providerId);
  assertEqual(deleted, true);
  assertEqual(providerRegistry.getProvider(p.providerId), null);
});

// ─── 3. ModelRegistry ───
console.log('Compute.3: ModelRegistry');
test('createModel stores and returns model', () => {
  modelRegistry.ensureSchema();
  const prov = providerRegistry.createProvider({ displayName: 'test-prov', providerType: 'mock', endpoint: 'http://mock' });
  const m = modelRegistry.createModel({
    providerId: prov.providerId,
    providerModelName: 'llama3.1:8b',
    displayName: 'Llama 3.1 8B',
    contextLimit: 8192,
    supportsVision: false,
    supportsTools: true
  });
  assertOk(m.modelId, 'has modelId');
  assertEqual(m.providerModelName, 'llama3.1:8b');
  assertEqual(m.supportsTools, true);
});

test('listModels and getModel', () => {
  const list = modelRegistry.listModels();
  assertOk(list.length >= 1);
  const found = modelRegistry.getModel(list[0].modelId);
  assertOk(found);
  assertEqual(found.providerModelName, 'llama3.1:8b');
});

test('deleteModel', () => {
  const prov = providerRegistry.createProvider({ displayName: 'temp-prov', providerType: 'mock', endpoint: 'http://x' });
  const m = modelRegistry.createModel({ providerId: prov.providerId, providerModelName: 'temp' });
  assertEqual(modelRegistry.deleteModel(m.modelId), true);
  assertEqual(modelRegistry.getModel(m.modelId), null);
});

// ─── 4. JobManager ───
console.log('Compute.4: JobManager');
test('createJob stores and returns job', () => {
  jobManager.ensureSchema();
  const j = jobManager.createJob({
    jobType: 'chat',
    capability: 'chat',
    requestPayload: { model: 'llama3.1:8b', prompt: 'Hello world' }
  });
  assertOk(j.jobId, 'has jobId');
  assertEqual(j.status, 'queued');
  assertEqual(j.jobType, 'chat');
  assertEqual(j.attempt, 0);
});

test('listJobs and getJob', () => {
  const list = jobManager.listJobs();
  assertOk(list.length >= 1);
  const found = jobManager.getJob(list[0].jobId);
  assertOk(found);
  assertEqual(found.status, 'queued');
});

test('transitionJob queued->leased->starting->running', () => {
  const list = jobManager.listJobs();
  const j = list[0];
  jobManager.transitionJob(j.jobId, 'leased', { workerId: 'w1' });
  jobManager.transitionJob(j.jobId, 'starting', { workerId: 'w1' });
  const r = jobManager.transitionJob(j.jobId, 'running', { workerId: 'w1' });
  assertEqual(r.status, 'running');
  assertOk(r.startedAt !== null);
});

test('transitionJob running->completed', () => {
  const list = jobManager.listJobs({ status: 'running' });
  assertOk(list.length >= 1);
  const j = jobManager.transitionJob(list[0].jobId, 'completed', { result: { output: 'ok' } });
  assertEqual(j.status, 'completed');
});

test('cancelJob moves to cancelled', () => {
  const j = jobManager.createJob({ jobType: 'chat', capability: 'chat', requestPayload: {} });
  const cancelled = jobManager.transitionJob(j.jobId, 'cancelled', { cancelReason: 'test' });
  assertEqual(cancelled.status, 'cancelled');
});

test('getJobStats returns counts', () => {
  const stats = jobManager.getJobStats();
  assertOk(stats.total >= 1);
  assertOk(typeof stats.byStatus === 'object');
});

test('createArtifact and listArtifacts', () => {
  const list = jobManager.listJobs();
  const j = list[0];
  jobManager.createArtifact(j.jobId, { artifactType: 'output', name: 'result.txt', contentType: 'text/plain' });
  const arts = jobManager.listArtifacts(j.jobId);
  assertOk(arts.length >= 1);
  assertEqual(arts[0].artifact_type, 'output');
});

// ─── 5. WorkerManager ───
console.log('Compute.5: WorkerManager');
test('createEnrollmentToken and enroll', () => {
  workerManager.ensureSchema();
  const token = workerManager.createEnrollmentToken({ displayName: 'test-gpu-worker' });
  assertOk(token.token, 'has token');
  assertOk(token.expiresAt, 'has expiresAt');
  const w = workerManager.enrollWorker({
    nodeId: 'gpu-node-1',
    displayName: 'test-gpu',
    platform: 'linux',
    architecture: 'x64',
    accelerators: [{ type: 'nvidia', vram: 12000 }],
    enrollmentToken: token.token
  });
  assertOk(w.workerId, 'has workerId');
  assertEqual(w.nodeId, 'gpu-node-1');
  assertEqual(w.state, 'online');
});

test('listWorkers and getWorker', () => {
  const list = workerManager.listWorkers();
  assertOk(list.length >= 1);
  const found = workerManager.getWorker(list[0].workerId);
  assertOk(found);
});

test('heartbeat updates lastSeen', () => {
  const list = workerManager.listWorkers();
  const w = workerManager.heartbeat(list[0].workerId, { currentJobs: 0 });
  assertOk(w.lastHeartbeat);
  assertEqual(w.state, 'online');
});

test('revokeWorker sets state revoked', () => {
  const token = workerManager.createEnrollmentToken({ displayName: 'temp-worker' });
  const w2 = workerManager.enrollWorker({
    nodeId: 'temp-node',
    displayName: 'temp',
    platform: 'linux',
    enrollmentToken: token.token
  });
  workerManager.revokeWorker(w2.workerId, 'test_revoke');
  const revoked = workerManager.getWorker(w2.workerId);
  assertEqual(revoked.state, 'revoked');
});

test('getWorkerStats returns counts', () => {
  const stats = workerManager.getWorkerStats();
  assertOk(typeof stats.total === 'number');
  assertOk(typeof stats.byState === 'object');
});

// ─── 6. ExecutorRegistry ───
console.log('Compute.6: ExecutorRegistry');
test('registerExecutor and list', () => {
  executorRegistry.registerExecutor({
    type: 'test.exec',
    version: '1',
    description: 'Test executor',
    workloadClass: 'custom',
    execute: async () => ({ ok: true })
  });
  const list = executorRegistry.listExecutors();
  assertOk(list.length >= 1);
  const found = list.find(e => e.type === 'test.exec');
  assertOk(found);
  assertEqual(found.description, 'Test executor');
});

test('executeJob runs executor', async () => {
  const result = await executorRegistry.executeJob('model.benchmark', {}, { model: 'test' });
  assertOk(result, 'has result');
  assertOk(result.success === true);
  assertOk(typeof result.durationMs === 'number');
});

test('executeJob unknown executor throws', async () => {
  try {
    await executorRegistry.executeJob('nonexistent', {}, {});
    assert.fail('should have thrown');
  } catch (e) {
    assertOk(e.message.includes('Unknown executor'));
  }
});

// ─── 7. MockProvider ───
console.log('Compute.7: MockProvider');
test('MockProvider chat returns response', async () => {
  const mp = new MockProvider({ name: 'mock1', endpoint: 'http://mock' });
  const r = await mp.chat({ model: 'test', messages: [{ role: 'user', content: 'hi' }] });
  assertOk(r.content, 'has content');
  assertOk(typeof r.content === 'string');
});

test('MockProvider health returns ok', async () => {
  const mp = new MockProvider({ name: 'mock1', endpoint: 'http://mock' });
  const h = await mp.health();
  assertEqual(h.healthy, true);
});

test('MockProvider listModels returns models', async () => {
  const mp = new MockProvider({ name: 'mock1', endpoint: 'http://mock' });
  const m = await mp.listModels();
  assertOk(Array.isArray(m));
  assertOk(m.length > 0);
});

// ─── 8. CapabilityRouter ───
console.log('Compute.8: CapabilityRouter');
test('CapabilityRouter returns result', async () => {
  const router = require('../src/compute/capability-router');
  const result = router.selectProvider({
    workloadClass: 'inference',
    dataClassification: 'public',
    trustLevel: 'community'
  });
  assertOk(typeof result === 'object');
  assertOk(typeof result.reason === 'string');
});

// ─── 9. InferenceService ───
console.log('Compute.9: InferenceService');
test('InferenceService initializes', () => {
  assertOk(inferenceService, 'loaded');
  assertOk(typeof inferenceService.chat === 'function', 'has chat');
});

// ─── 10. Initialize function ───
console.log('Compute.10: compute.initialize');
test('compute.initialize() runs without error', () => {
  compute.initialize();
});

test('compute.overview() returns shape', () => {
  const ov = compute.overview();
  assertOk(ov, 'has overview');
  assertOk(typeof ov === 'object');
});

// ─── 11. Tool handlers ───
console.log('Compute.11: tool handlers');
const computeTools = require('../src/compute/tools');

async function runAsyncTests() {
  await testAsync('sidekick_compute overview returns result', async () => {
    const r = await computeTools.sidekick_compute({ action: 'overview' });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
  });

  await testAsync('sidekick_compute_providers list returns result', async () => {
    const r = await computeTools.sidekick_compute_providers({ action: 'list' });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
  });

  await testAsync('sidekick_compute_models list returns result', async () => {
    const r = await computeTools.sidekick_compute_models({ action: 'list' });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
  });

  await testAsync('sidekick_compute_nodes list returns result', async () => {
    const r = await computeTools.sidekick_compute_nodes({ action: 'list' });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
  });

  await testAsync('sidekick_compute_jobs list returns result', async () => {
    const r = await computeTools.sidekick_compute_jobs({ action: 'list' });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
  });

  await testAsync('sidekick_compute_route explain returns result', async () => {
    const r = await computeTools.sidekick_compute_route({ action: 'explain', workload_class: 'inference' });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
  });

  await runEnrollmentToolTests();

  console.log(`\nCompute: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── 12. Enrollment token management ───
console.log('Compute.12: enrollment tokens');

test('createEnrollmentToken creates token with hash', () => {
  const result = workerManager.createEnrollmentToken({ displayName: 'test-worker', trustLevel: 'trusted', expiresInMs: 600000 });
  assertOk(result.tokenId, 'has tokenId');
  assertOk(result.token, 'has token');
  assertOk(result.token.startsWith('enroll_'), 'token has prefix');
  assertOk(result.expiresAt, 'has expiresAt');
});

test('createEnrollmentToken respects custom trust level', () => {
  const result = workerManager.createEnrollmentToken({ displayName: 'untrusted-worker', trustLevel: 'untrusted', expiresInMs: 300000 });
  assertOk(result.token, 'has token');
  const db = dbStore.getDb();
  const row = db.prepare('SELECT trust_level FROM compute_enrollment_tokens WHERE token_id = ?').get(result.tokenId);
  assert.strictEqual(row.trust_level, 'untrusted', 'trust level stored correctly');
});

test('consumeEnrollmentToken validates and marks consumed', () => {
  const result = workerManager.createEnrollmentToken({ displayName: 'consume-test', expiresInMs: 600000 });
  const consumed = workerManager.consumeEnrollmentToken(result.token, 'test-node-id');
  assertOk(consumed.tokenId, 'consumed has tokenId');
  assert.strictEqual(consumed.trustLevel, 'trusted', 'trust level passed through');
  assert.ok(Array.isArray(consumed.allowedDataClassifications), 'has allowedDataClassifications');
});

test('consumeEnrollmentToken rejects already-used token', () => {
  const result = workerManager.createEnrollmentToken({ displayName: 'double-use', expiresInMs: 600000 });
  workerManager.consumeEnrollmentToken(result.token, 'node-1');
  assert.throws(() => workerManager.consumeEnrollmentToken(result.token, 'node-2'), /already used/, 'rejects reuse');
});

test('consumeEnrollmentToken rejects expired token', () => {
  const result = workerManager.createEnrollmentToken({ displayName: 'expired', expiresInMs: -1000 });
  assert.throws(() => workerManager.consumeEnrollmentToken(result.token, 'node-x'), /expired/, 'rejects expired');
});

test('consumeEnrollmentToken rejects invalid token', () => {
  assert.throws(() => workerManager.consumeEnrollmentToken('enroll_garbage_token_abcdef123456', 'node-x'), /Invalid/, 'rejects invalid');
});

test('enrollWorker with valid token creates worker', () => {
  const tok = workerManager.createEnrollmentToken({ displayName: 'enroll-test', trustLevel: 'trusted', maxConcurrentJobs: 4 });
  const worker = workerManager.enrollWorker({
    nodeId: 'test-enroll-node-1',
    displayName: 'Enrolled Worker',
    platform: 'linux',
    architecture: 'x64',
    enrollmentToken: tok.token,
  });
  assertOk(worker.workerId, 'has workerId');
  assertOk(worker.nodeId === 'test-enroll-node-1', 'nodeId matches');
  assert.strictEqual(worker.maxConcurrentJobs, 4, 'maxConcurrentJobs from token');
  assert.strictEqual(worker.state, 'online', 'starts online');
});

// ─── 13. Tool handler enrollment actions ───
console.log('Compute.13: tool handler enrollment actions');

async function runEnrollmentToolTests() {
  await testAsync('create_token action returns token', async () => {
    const r = await computeTools.sidekick_compute_nodes({ action: 'create_token', display_name: 'tool-token-test', trust_level: 'trusted' });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
    const data = JSON.parse(r.content[0].text);
    assertOk(data.token, 'response has token');
    assertOk(data.tokenId, 'response has tokenId');
  });

  await testAsync('list_tokens action returns array', async () => {
    const r = await computeTools.sidekick_compute_nodes({ action: 'list_tokens' });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
    const data = JSON.parse(r.content[0].text);
    assert.ok(Array.isArray(data), 'returns array');
    assert.ok(data.length > 0, 'has tokens');
    assertOk(data[0].status, 'token has status');
  });

  await testAsync('enroll action creates worker', async () => {
    const tok = workerManager.createEnrollmentToken({ displayName: 'tool-enroll', expiresInMs: 600000 });
    const r = await computeTools.sidekick_compute_nodes({
      action: 'enroll', token: tok.token, node_id: 'tool-enroll-node',
      display_name: 'Tool Enrolled', platform: 'darwin',
    });
    assertOk(r.content, 'has content');
    assertOk(!r.isError, 'not error');
    const data = JSON.parse(r.content[0].text);
    assertOk(data.workerId, 'has workerId');
  });

  await testAsync('enroll action rejects missing fields', async () => {
    const r = await computeTools.sidekick_compute_nodes({ action: 'enroll', token: 'x' });
    assertOk(r.isError, 'is error');
  });
}

runAsyncTests().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
