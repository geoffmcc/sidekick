const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const packageJson = require('../package.json');

const TEST_DIR = path.join(__dirname, 'test-data-compute-protocol');
const API_KEY = 'sk-test-compute-protocol-key';
const PORT = 49197;

fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: route, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 15000;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) return;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw lastErr || new Error('server did not start');
}

async function waitForJobStatus(jobId, status, headers) {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    const res = await request('GET', `/compute/admin/jobs/${jobId}`, null, headers);
    if (res.status === 200) {
      last = res.data.job;
      if (last.status === status) return last;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`job ${jobId} did not reach ${status}; last status ${last?.status || 'unknown'}`);
}

async function waitForJobPredicate(jobId, headers, predicate, description) {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    const res = await request('GET', `/compute/admin/jobs/${jobId}`, null, headers);
    if (res.status === 200) {
      last = res.data.job;
      if (predicate(last, res.data)) return res.data;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`job ${jobId} did not satisfy ${description}; last status ${last?.status || 'unknown'}`);
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error('process did not exit')), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function deepPayload(depth) {
  let value = 'leaf';
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
}

async function main() {
  console.log('Running Compute Protocol Integration Tests...');
  const env = { ...process.env, SIDEKICK_DATA_DIR: TEST_DIR, SIDEKICK_PORT: String(PORT), SIDEKICK_API_KEY: API_KEY };
  const child = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', c => logs += c.toString());
  child.stderr.on('data', c => logs += c.toString());
  try {
    await waitForServer(child);
    const admin = { Authorization: `Bearer ${API_KEY}` };

    const healthRes = await request('GET', '/health');
    assert.strictEqual(healthRes.status, 200, 'health endpoint is reachable');
    assert.strictEqual(healthRes.data.version, packageJson.version, 'health version matches package version');
    assert.strictEqual(healthRes.data.runtime.node, process.version, 'health runtime reports Node version');
    assert.strictEqual(healthRes.data.runtime.requiredNode, packageJson.engines.node, 'health runtime reports package Node requirement');

    assert.strictEqual((await request('GET', '/compute/unprotected-test')).status, 401, 'unknown compute route fails closed without auth');
    assert.strictEqual((await request('POST', '/compute/enrollment/exchange', { token: 'x' }, { 'Content-Type': 'text/plain' })).status, 415, 'compute protocol rejects non-json content type');

    const tokenRes = await request('POST', '/compute/enrollment/tokens', { displayName: 'http-worker', expiresInMs: 600000, maxConcurrentJobs: 1 }, admin);
    assert.strictEqual(tokenRes.status, 200, 'admin can create enrollment token');
    assert.ok(tokenRes.data.token && tokenRes.data.token.startsWith('enroll_'), 'token returned once');

    const enrollRes = await request('POST', '/compute/enrollment/exchange', {
      token: tokenRes.data.token,
      nodeId: 'proto-node-1',
      displayName: 'Protocol Worker',
      platform: process.platform,
      executors: [{ type: 'mock.inference', capabilities: ['chat', 'generate', 'embeddings'] }],
      providers: [{ type: 'mock', endpoint: 'in-process' }],
      modelInventory: [{ name: 'deterministic-test', provider: 'mock', capabilities: ['chat'] }],
      limits: { maxConcurrentJobs: 2, maxResultBytes: 524288 },
      health: { status: 'healthy', backends: [{ type: 'mock', status: 'configured' }] },
      protocolVersion: '1',
    });
    assert.strictEqual(enrollRes.status, 200, 'worker enrolls');
    assert.ok(enrollRes.data.credential, 'persistent credential returned');
    const workerId = enrollRes.data.worker.workerId;
    const credential = enrollRes.data.credential;
    let activeCredential = credential;
    let workerAuth = { Authorization: `Bearer ${workerId}:${activeCredential}` };

    const tokenResB = await request('POST', '/compute/enrollment/tokens', { displayName: 'http-worker-b', expiresInMs: 600000, maxConcurrentJobs: 1 }, admin);
    const enrollResB = await request('POST', '/compute/enrollment/exchange', {
      token: tokenResB.data.token,
      nodeId: 'proto-node-2',
      displayName: 'Protocol Worker B',
      platform: process.platform,
      executors: [{ type: 'mock.inference', capabilities: ['chat', 'generate', 'embeddings'] }],
      providers: [{ type: 'mock', endpoint: 'in-process' }],
      protocolVersion: '1',
    });
    assert.strictEqual(enrollResB.status, 200, 'second worker enrolls');
    const workerIdB = enrollResB.data.worker.workerId;
    const workerAuthB = { Authorization: `Bearer ${workerIdB}:${enrollResB.data.credential}` };

    const tokenResC = await request('POST', '/compute/enrollment/tokens', { displayName: 'incompatible-worker', expiresInMs: 600000, maxConcurrentJobs: 1 }, admin);
    const enrollResC = await request('POST', '/compute/enrollment/exchange', {
      token: tokenResC.data.token,
      nodeId: 'proto-node-3',
      displayName: 'Incompatible Worker',
      platform: process.platform,
      executors: [],
      providers: [],
      protocolVersion: '1',
    });
    assert.strictEqual(enrollResC.status, 200, 'incompatible worker enrolls');
    const workerAuthC = { Authorization: `Bearer ${enrollResC.data.worker.workerId}:${enrollResC.data.credential}` };

    const reuseRes = await request('POST', '/compute/enrollment/exchange', { token: tokenRes.data.token, nodeId: 'proto-node-reuse', displayName: 'Reuse', platform: process.platform });
    assert.strictEqual(reuseRes.status, 400, 'enrollment token reuse rejected');
    const invalidTokenRes = await request('POST', '/compute/enrollment/exchange', { token: 'enroll_invalid', nodeId: 'proto-node-invalid', displayName: 'Invalid', platform: process.platform });
    assert.strictEqual(invalidTokenRes.status, 400, 'invalid enrollment token rejected');
    const expiredToken = await request('POST', '/compute/enrollment/tokens', { displayName: 'expired-worker', expiresInMs: -1 }, admin);
    assert.strictEqual(expiredToken.status, 200, 'expired token created for negative-lifetime test');
    const expiredTokenRes = await request('POST', '/compute/enrollment/exchange', { token: expiredToken.data.token, nodeId: 'proto-node-expired', displayName: 'Expired', platform: process.platform });
    assert.strictEqual(expiredTokenRes.status, 400, 'expired enrollment token rejected');
    assert.strictEqual((await request('POST', '/compute/worker/heartbeat', { currentJobs: 0 }, { Authorization: `Bearer ${workerId}:bad` })).status, 401, 'bad worker credential rejected');
    assert.strictEqual((await request('POST', '/compute/worker/heartbeat', { currentJobs: 0 }, admin)).status, 401, 'admin key rejected on worker route');
    const heartbeatRes = await request('POST', '/compute/worker/heartbeat', {
      currentJobs: 0,
      executors: [{ type: 'mock.inference', capabilities: ['chat'] }],
      modelInventory: [{ name: 'deterministic-test', provider: 'mock', capabilities: ['chat', 'generate'] }],
      limits: { maxConcurrentJobs: 2, maxResultBytes: 524288 },
      health: { status: 'healthy', backends: [{ type: 'mock', status: 'configured' }] },
    }, workerAuth);
    assert.strictEqual(heartbeatRes.status, 200, 'heartbeat accepted');
    assert.strictEqual(heartbeatRes.data.worker.modelInventory[0].name, 'deterministic-test', 'model inventory persisted from heartbeat');
    assert.strictEqual(heartbeatRes.data.worker.health.status, 'healthy', 'worker health persisted from heartbeat');
    assert.strictEqual((await request('POST', '/compute/admin/jobs', { jobType: 'chat' }, workerAuth)).status, 401, 'worker credential rejected on admin route');

    const incompatibleJob = await request('POST', '/compute/admin/jobs', { jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'diagnostics' } }, admin);
    assert.strictEqual(incompatibleJob.status, 200, 'diagnostics job submitted');
    const incompatibleClaim = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuthC);
    assert.strictEqual(incompatibleClaim.status, 200, 'incompatible claim returns clean response');
    assert.strictEqual(incompatibleClaim.data.claimed, false, 'incompatible worker does not claim job');
    const incompatibleDetail = await request('GET', `/compute/admin/jobs/${incompatibleJob.data.job.jobId}`, null, admin);
    assert.strictEqual(incompatibleDetail.data.job.schedulingDiagnostics.selected, false, 'scheduler records rejected decision');
    assert.ok(incompatibleDetail.data.job.schedulingDiagnostics.rejected[0].reasons.some(r => r.startsWith('capability_missing')), 'scheduler records rejection reason');
    await request('POST', `/compute/admin/jobs/${incompatibleJob.data.job.jobId}/cancel`, { reason: 'diagnostics-complete' }, admin);

    const jobRes = await request('POST', '/compute/admin/jobs', { jobType: 'chat', capability: 'chat', protocolVersion: '1', priority: 25, requestPayload: { prompt: 'hello protocol' }, dataClassification: 'private' }, admin);
    assert.strictEqual(jobRes.status, 200, 'job submitted');
    assert.strictEqual(jobRes.data.job.protocolVersion, '1', 'job protocol version stored');
    assert.strictEqual(jobRes.data.job.priority, 25, 'job priority stored');
    assert.strictEqual((await request('POST', '/compute/admin/jobs', { jobType: 'custom', requestPayload: { prompt: 'nope' } }, admin)).status, 400, 'unsupported custom job rejected');
    assert.strictEqual((await request('POST', '/compute/admin/jobs', { jobType: 'chat', requestPayload: { command: 'touch /tmp/pwned' } }, admin)).status, 400, 'shell command payload rejected');
    assert.strictEqual((await request('POST', '/compute/admin/jobs', { jobType: 'chat', protocolVersion: '99', requestPayload: { prompt: 'bad version' } }, admin)).status, 400, 'unsupported job protocol rejected');
    assert.strictEqual((await request('POST', '/compute/admin/jobs', { jobType: 'chat', requestPayload: deepPayload(12) }, admin)).status, 400, 'over-deep job payload rejected');

    const claimRes = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuth);
    assert.strictEqual(claimRes.status, 200, 'claim response ok');
    assert.strictEqual(claimRes.data.claimed, true, 'job claimed');
    const jobId = claimRes.data.job.jobId;
    const leaseId = claimRes.data.leaseId;

    const duplicateClaim = await Promise.all([
      request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuth),
      request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuth),
    ]);
    assert.ok(duplicateClaim.every(r => r.status === 200 && r.data.claimed === false), 'already claimed job is not double assigned');

    const startRes = await request('POST', `/compute/worker/jobs/${jobId}/start`, { leaseId }, workerAuth);
    assert.strictEqual(startRes.status, 200, `start accepted: ${JSON.stringify(startRes.data)}`);
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/progress`, { leaseId, progressPercent: 1 }, workerAuthB)).status, 409, 'worker B cannot update worker A leased job');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/renew`, { leaseId, leaseDurationMs: 60000 }, workerAuth)).status, 200, 'renew accepted');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/progress`, { leaseId, progressPercent: 55, progressMessage: 'halfway' }, workerAuth)).status, 200, 'progress accepted');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/cancellation`, { leaseId })).status, 401, 'cancellation status requires worker auth');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/cancellation`, { leaseId }, admin)).status, 401, 'admin key rejected on cancellation worker route');
    const legacyCancellationStatus = await request('POST', `/compute/jobs/${jobId}/cancellation`, { leaseId }, workerAuth);
    assert.strictEqual(legacyCancellationStatus.status, 200, 'legacy cancellation status alias accepts worker auth');
    assert.strictEqual(legacyCancellationStatus.data.cancellation.cancelled, false, 'legacy cancellation status alias reports active job');

    const artifactContent = 'mock:hello protocol';
    const artifactHash = require('crypto').createHash('sha256').update(artifactContent).digest('hex');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/artifacts/upload`, { leaseId, name: 'unauth.txt', content: 'x' })).status, 401, 'artifact upload requires worker auth');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/artifacts/upload`, { leaseId, name: 'admin.txt', content: 'x' }, admin)).status, 401, 'admin key rejected on artifact worker route');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/artifacts/upload`, { leaseId, name: 'huge.txt', sizeBytes: 11 * 1024 * 1024 }, workerAuth)).status, 409, 'artifact upload rejects declared oversize artifact');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/artifacts/not-real/finalize`, { leaseId }, workerAuth)).status, 409, 'artifact finalize rejects unknown artifact');
    const artifactUpload = await request('POST', `/compute/worker/jobs/${jobId}/artifacts/upload`, { leaseId, name: 'result.txt', content: artifactContent, contentType: 'text/plain', artifactType: 'result', contentHash: artifactHash, sizeBytes: Buffer.byteLength(artifactContent) }, workerAuth);
    assert.strictEqual(artifactUpload.status, 200, 'artifact upload accepted');
    assert.strictEqual(artifactUpload.data.artifact.state, 'uploaded', 'artifact starts uploaded');
    assert.strictEqual(artifactUpload.data.artifact.contentHash, artifactHash, 'artifact hash recorded');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/complete`, { leaseId, result: { content: 'too early' }, artifactIds: [artifactUpload.data.artifact.artifactId] }, workerAuth)).status, 409, 'completion rejects unfinalized referenced artifact');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/artifacts/upload`, { leaseId, name: 'bad.txt', content: 'bad', contentHash: 'wrong' }, workerAuth)).status, 409, 'artifact upload rejects hash mismatch');
    const legacyArtifactUpload = await request('POST', `/compute/jobs/${jobId}/artifacts/upload`, { leaseId, name: 'legacy.txt', content: 'legacy', contentType: 'text/plain', artifactType: 'diagnostic' }, workerAuth);
    assert.strictEqual(legacyArtifactUpload.status, 200, 'legacy artifact upload alias accepts worker auth');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/artifacts/${artifactUpload.data.artifact.artifactId}/finalize`, { leaseId, contentHash: artifactHash, sizeBytes: 999 }, workerAuth)).status, 409, 'artifact finalize rejects size mismatch');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${jobId}/artifacts/${artifactUpload.data.artifact.artifactId}/finalize`, { leaseId, contentHash: artifactHash, sizeBytes: Buffer.byteLength(artifactContent) }, workerAuthB)).status, 409, 'worker B cannot finalize worker A artifact');
    const artifactFinalize = await request('POST', `/compute/worker/jobs/${jobId}/artifacts/${artifactUpload.data.artifact.artifactId}/finalize`, { leaseId, contentHash: artifactHash, sizeBytes: Buffer.byteLength(artifactContent) }, workerAuth);
    assert.strictEqual(artifactFinalize.status, 200, 'artifact finalize accepted');
    assert.strictEqual(artifactFinalize.data.artifact.state, 'finalized', 'artifact finalized');
    const duplicateFinalize = await request('POST', `/compute/worker/jobs/${jobId}/artifacts/${artifactUpload.data.artifact.artifactId}/finalize`, { leaseId, contentHash: artifactHash, sizeBytes: Buffer.byteLength(artifactContent) }, workerAuth);
    assert.strictEqual(duplicateFinalize.status, 200, 'artifact finalize idempotent');
    const legacyArtifactFinalize = await request('POST', `/compute/jobs/${jobId}/artifacts/${legacyArtifactUpload.data.artifact.artifactId}/finalize`, { leaseId, contentHash: legacyArtifactUpload.data.artifact.contentHash, sizeBytes: legacyArtifactUpload.data.artifact.sizeBytes }, workerAuth);
    assert.strictEqual(legacyArtifactFinalize.status, 200, 'legacy artifact finalize alias accepts worker auth');

    const completeRes = await request('POST', `/compute/worker/jobs/${jobId}/complete`, { leaseId, result: { content: 'mock:hello protocol' }, artifactIds: [artifactUpload.data.artifact.artifactId] }, workerAuth);
    assert.strictEqual(completeRes.status, 200, 'completion accepted');
    assert.strictEqual(completeRes.data.job.status, 'completed', 'job completed');

    const duplicateComplete = await request('POST', `/compute/worker/jobs/${jobId}/complete`, { leaseId, result: { content: 'duplicate' } }, workerAuth);
    assert.strictEqual(duplicateComplete.status, 200, 'duplicate completion idempotent');
    assert.strictEqual(duplicateComplete.data.job.result.content, 'mock:hello protocol', 'duplicate completion did not overwrite result');

    const detail = await request('GET', `/compute/admin/jobs/${jobId}`, null, admin);
    assert.strictEqual(detail.status, 200, 'job detail retrievable');
    assert.strictEqual(detail.data.job.status, 'completed', 'detail shows terminal state');
    assert.ok(detail.data.attempts.length >= 1, 'job detail includes attempts');
    assert.strictEqual(detail.data.attempts[0].workerId, workerId, 'attempt includes worker identity');
    assert.ok(detail.data.artifacts.length >= 1, 'artifact metadata recorded');
    assert.ok(detail.data.artifacts.some(a => a.artifactId === artifactUpload.data.artifact.artifactId && a.state === 'finalized'), 'finalized uploaded artifact appears in detail');
    const jobList = await request('GET', '/compute/admin/jobs?status=completed&limit=10', null, admin);
    assert.strictEqual(jobList.status, 200, 'admin can list jobs');
    assert.ok(jobList.data.jobs.some(j => j.jobId === jobId), 'job list includes completed job');
    assert.ok(jobList.data.stats.attempts >= 1, 'job list includes attempt stats');
    assert.ok(jobList.data.stats.artifacts.finalized >= 1, 'job list includes artifact state stats');

    const workerDetail = await request('GET', `/compute/admin/workers/${workerId}`, null, admin);
    assert.strictEqual(workerDetail.status, 200, 'admin can inspect worker');
    assert.strictEqual(workerDetail.data.worker.hasCredential, true, 'worker detail does not expose credential but marks it present');
    assert.strictEqual(workerDetail.data.worker.credential, undefined, 'worker credential not exposed in detail');
    assert.strictEqual(workerDetail.data.worker.modelInventory[0].name, 'deterministic-test', 'admin can inspect model inventory');
    assert.strictEqual(workerDetail.data.worker.limits.maxResultBytes, 524288, 'admin can inspect worker limits');
    assert.strictEqual(workerDetail.data.worker.health.status, 'healthy', 'admin can inspect backend health');

    const distributedJobs = await Promise.all([
      request('POST', '/compute/admin/jobs', { jobType: 'chat', requestPayload: { prompt: 'one' } }, admin),
      request('POST', '/compute/admin/jobs', { jobType: 'chat', requestPayload: { prompt: 'two' } }, admin),
    ]);
    assert.ok(distributedJobs.every(r => r.status === 200), 'multiple jobs submitted');
    const distributedClaims = await Promise.all([
      request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuth),
      request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuthB),
    ]);
    assert.ok(distributedClaims.every(r => r.status === 200 && r.data.claimed === true), 'multiple workers can claim separate jobs');
    assert.notStrictEqual(distributedClaims[0].data.job.jobId, distributedClaims[1].data.job.jobId, 'multiple workers did not claim the same job');
    const overLimitClaim = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuth);
    assert.strictEqual(overLimitClaim.status, 200, 'over-limit claim returns clean response');
    assert.strictEqual(overLimitClaim.data.claimed, false, 'worker concurrency limit prevents extra claim');
    await request('POST', `/compute/admin/jobs/${distributedClaims[0].data.job.jobId}/cancel`, { reason: 'cleanup' }, admin);
    await request('POST', `/compute/admin/jobs/${distributedClaims[1].data.job.jobId}/cancel`, { reason: 'cleanup' }, admin);

    const cancelledJob = await request('POST', '/compute/admin/jobs', { jobType: 'chat', requestPayload: { prompt: 'cancel wins' } }, admin);
    const cancelledClaim = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuthB);
    assert.strictEqual(cancelledClaim.data.claimed, true, 'job claimed before cancellation');
    const cancelBeforeComplete = await request('POST', `/compute/admin/jobs/${cancelledClaim.data.job.jobId}/cancel`, { reason: 'cancel-before-complete' }, admin);
    assert.strictEqual(cancelBeforeComplete.data.job.status, 'cancelled', 'admin cancellation recorded');
    const cancellationStatus = await request('POST', `/compute/worker/jobs/${cancelledClaim.data.job.jobId}/cancellation`, { leaseId: cancelledClaim.data.leaseId }, workerAuthB);
    assert.strictEqual(cancellationStatus.status, 200, 'worker can check cancellation status');
    assert.strictEqual(cancellationStatus.data.cancellation.cancelled, true, 'worker sees cancellation request');
    const cancellationAck = await request('POST', `/compute/worker/jobs/${cancelledClaim.data.job.jobId}/cancellation/ack`, { leaseId: cancelledClaim.data.leaseId }, workerAuthB);
    assert.strictEqual(cancellationAck.status, 200, 'worker can acknowledge cancellation');
    assert.ok(cancellationAck.data.job.cancelAcknowledgedAt, 'cancellation acknowledgement recorded');
    const duplicateAck = await request('POST', `/compute/worker/jobs/${cancelledClaim.data.job.jobId}/cancellation/ack`, { leaseId: cancelledClaim.data.leaseId }, workerAuthB);
    assert.strictEqual(duplicateAck.status, 200, 'cancellation acknowledgement idempotent');
    const delayedComplete = await request('POST', `/compute/worker/jobs/${cancelledClaim.data.job.jobId}/complete`, { leaseId: cancelledClaim.data.leaseId, result: { content: 'too late' } }, workerAuthB);
    assert.strictEqual(delayedComplete.status, 409, 'cancellation wins over delayed completion');
    assert.strictEqual((await request('POST', `/compute/worker/jobs/${cancelledClaim.data.job.jobId}/artifacts/upload`, { leaseId: cancelledClaim.data.leaseId, name: 'late.txt', content: 'too late' }, workerAuthB)).status, 409, 'cancelled job rejects delayed artifact upload');

    const retryWaitJob = await request('POST', '/compute/admin/jobs', { jobType: 'chat', requestPayload: { prompt: 'retry wait' }, maxAttempts: 2, retryPolicy: { backoffMs: 500, maxBackoffMs: 500 } }, admin);
    assert.strictEqual(retryWaitJob.status, 200, 'retry-wait job submitted');
    const retryWaitClaim = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuthB);
    assert.strictEqual(retryWaitClaim.data.claimed, true, 'retry-wait job claimed');
    await request('POST', `/compute/worker/jobs/${retryWaitClaim.data.job.jobId}/start`, { leaseId: retryWaitClaim.data.leaseId }, workerAuthB);
    const failForRetry = await request('POST', `/compute/worker/jobs/${retryWaitClaim.data.job.jobId}/fail`, { leaseId: retryWaitClaim.data.leaseId, errorCategory: 'test_failure', errorMessage: 'temporary' }, workerAuthB);
    assert.strictEqual(failForRetry.status, 200, 'worker failure accepted');
    assert.strictEqual(failForRetry.data.job.status, 'retry_wait', 'failed job enters retry_wait');
    assert.ok(failForRetry.data.job.retryAfter, 'retry_after recorded');
    const immediateRetryClaim = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuthB);
    assert.strictEqual(immediateRetryClaim.data.claimed, false, 'retry_wait job is not immediately claimable');
    await new Promise(r => setTimeout(r, 550));
    const dueRetryClaim = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuthB);
    assert.strictEqual(dueRetryClaim.data.claimed, true, 'retry_wait job becomes claimable after backoff');
    await request('POST', `/compute/admin/jobs/${dueRetryClaim.data.job.jobId}/cancel`, { reason: 'retry-wait-cleanup' }, admin);

    const disableRes = await request('POST', `/compute/admin/workers/${workerId}/disable`, { reason: 'test-disable' }, admin);
    assert.strictEqual(disableRes.status, 200, 'admin can disable worker');
    assert.strictEqual(disableRes.data.worker.maintenanceMode, true, 'worker put into maintenance');
    const claimWhileMaintenance = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuth);
    assert.strictEqual(claimWhileMaintenance.status, 200, 'claim endpoint returns 200 for maintenance worker');
    assert.strictEqual(claimWhileMaintenance.data.claimed, false, 'worker in maintenance cannot claim new jobs');
    assert.strictEqual(claimWhileMaintenance.data.reason, 'in_maintenance', 'claim refusal reason is surfaced');
    const enableRes = await request('POST', `/compute/admin/workers/${workerId}/enable`, { reason: 'test-enable' }, admin);
    assert.strictEqual(enableRes.status, 200, 'admin can enable worker');
    assert.strictEqual(enableRes.data.worker.maintenanceMode, false, 'worker maintenance cleared');
    assert.strictEqual((await request('POST', '/compute/worker/heartbeat', { currentJobs: 0, executors: [{ type: 'mock.inference', capabilities: ['chat'] }] }, workerAuth)).status, 200, 'enabled worker can heartbeat again');

    const disconnectRes = await request('POST', '/compute/worker/disconnect', { reason: 'test-shutdown' }, workerAuth);
    assert.strictEqual(disconnectRes.status, 200, 'worker can gracefully disconnect');
    assert.strictEqual(disconnectRes.data.worker.connectionState, 'offline', 'disconnect drops connection to offline');
    assert.strictEqual(disconnectRes.data.worker.lastDisconnectReason, 'test-shutdown', 'disconnect reason recorded');
    assert.strictEqual((await request('POST', '/compute/worker/disconnect', {}, { Authorization: `Bearer ${workerId}:bad` })).status, 401, 'disconnect requires worker auth');
    const reheartbeat = await request('POST', '/compute/worker/heartbeat', { currentJobs: 0 }, workerAuth);
    assert.strictEqual(reheartbeat.status, 200, 'worker can heartbeat after disconnect');
    assert.strictEqual(reheartbeat.data.worker.connectionState, 'online', 'heartbeat reconnects after graceful disconnect');

    const rotateRes = await request('POST', `/compute/admin/workers/${workerId}/credentials/rotate`, {}, admin);
    assert.strictEqual(rotateRes.status, 200, 'admin can rotate worker credential');
    assert.ok(rotateRes.data.credential && rotateRes.data.credential !== activeCredential, 'rotation returns a new credential once');
    assert.strictEqual((await request('POST', '/compute/worker/heartbeat', { currentJobs: 0 }, workerAuth)).status, 401, 'old worker credential rejected after rotation');
    activeCredential = rotateRes.data.credential;
    workerAuth = { Authorization: `Bearer ${workerId}:${activeCredential}` };
    assert.strictEqual((await request('POST', '/compute/worker/heartbeat', { currentJobs: 0 }, workerAuth)).status, 200, 'new worker credential accepted after rotation');

    await request('POST', '/compute/admin/jobs', { jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'stale' }, maxAttempts: 1 }, admin);
    const staleClaim = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 1 }, workerAuth);
    await new Promise(r => setTimeout(r, 20));
    const staleComplete = await request('POST', `/compute/worker/jobs/${staleClaim.data.job.jobId}/complete`, { leaseId: staleClaim.data.leaseId, result: { content: 'too late' } }, workerAuth);
    assert.strictEqual(staleComplete.status, 409, 'stale lease completion rejected');
    const recover = await request('POST', '/compute/admin/recover', {}, admin);
    assert.strictEqual(recover.status, 200, 'recovery endpoint works');
    assert.ok(recover.data.recovered >= 1, 'expired lease recovered');

    const retryRace = await Promise.all([
      request('POST', `/compute/admin/jobs/${staleClaim.data.job.jobId}/retry`, { reason: 'test-retry-a' }, admin),
      request('POST', `/compute/admin/jobs/${staleClaim.data.job.jobId}/retry`, { reason: 'test-retry-b' }, admin),
    ]);
    const retrySuccesses = retryRace.filter(r => r.status === 200);
    assert.strictEqual(retrySuccesses.length, 1, 'concurrent retry creates one queued retry');
    const retryRes = retrySuccesses[0];
    assert.strictEqual(retryRes.status, 200, 'admin retry endpoint works');
    assert.strictEqual(retryRes.data.job.status, 'queued', 'retry requeues dead-lettered job');
    const retryClaim = await request('POST', '/compute/worker/jobs/claim', { leaseDurationMs: 60000 }, workerAuth);
    assert.strictEqual(retryClaim.status, 200, 'retried job can be claimed');
    assert.strictEqual(retryClaim.data.claimed, true, 'retried job claimed');
    const cancelRetry = await request('POST', `/compute/admin/jobs/${retryClaim.data.job.jobId}/cancel`, { reason: 'test-cancel' }, admin);
    assert.strictEqual(cancelRetry.status, 200, 'admin cancellation endpoint works');
    assert.strictEqual(cancelRetry.data.job.status, 'cancelled', 'cancelled job remains terminal');

    const agentToken = await request('POST', '/compute/enrollment/tokens', { displayName: 'agent-worker', expiresInMs: 600000 }, admin);
    assert.strictEqual(agentToken.status, 200, 'admin can create agent enrollment token');
    const agentConfig = path.join(TEST_DIR, 'agent-worker-credential.json');
    const agentEnv = {
      ...process.env,
      SIDEKICK_URL: `http://127.0.0.1:${PORT}`,
      SIDEKICK_ENROLL_TOKEN: agentToken.data.token,
      SIDEKICK_NODE_ID: 'proto-agent-node',
      SIDEKICK_NODE_NAME: 'Protocol Agent Worker',
      SIDEKICK_WORKER_CONFIG: agentConfig,
      SIDEKICK_WORKER_POLL_MS: '100',
      SIDEKICK_HEARTBEAT_MS: '1000',
      OLLAMA_URL: 'http://user:pass@127.0.0.1:11434',
      OLLAMA_MODEL: 'llama3-test',
      SIDEKICK_WORKER_ACCELERATORS_JSON: JSON.stringify([{ type: 'test-gpu', vendor: 'test-vendor', name: 'deterministic accelerator', memoryBytes: 123456 }]),
      SIDEKICK_WORKER_MODELS_JSON: JSON.stringify([{ name: 'configured-model', provider: 'configured-backend', capabilities: ['chat'], contextWindow: 2048 }]),
    };
    const agent = spawn(process.execPath, ['src/compute/worker-agent.js'], { cwd: path.join(__dirname, '..'), env: agentEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let agentLogs = '';
    agent.stdout.on('data', c => agentLogs += c.toString());
    agent.stderr.on('data', c => agentLogs += c.toString());
    try {
      await new Promise(r => setTimeout(r, 1000));
      const agentJob = await request('POST', '/compute/admin/jobs', { jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'agent runtime' }, dataClassification: 'private' }, admin);
      assert.strictEqual(agentJob.status, 200, 'agent runtime job submitted');
      const completedAgentJob = await waitForJobStatus(agentJob.data.job.jobId, 'completed', admin);
      assert.strictEqual(completedAgentJob.result.content, 'mock:agent runtime', 'real worker agent completed deterministic job');
      const completedAgentDetail = await request('GET', `/compute/admin/jobs/${agentJob.data.job.jobId}`, null, admin);
      assert.ok(completedAgentDetail.data.artifacts.length >= 1, 'real worker agent recorded result artifact metadata');
      assert.ok(fs.existsSync(agentConfig), 'worker agent persisted credential config');
      if (process.platform !== 'win32' && !agentConfig.startsWith('/mnt/')) assert.strictEqual((fs.statSync(agentConfig).mode & 0o077), 0, 'worker agent credential config is not group/world accessible');
      const agentWorkerDetail = await request('GET', `/compute/admin/workers/${completedAgentJob.selectedWorkerId}`, null, admin);
      assert.strictEqual(agentWorkerDetail.status, 200, 'admin can inspect real worker-agent reporting');
      assert.ok(agentWorkerDetail.data.worker.accelerators.some(a => a.type === 'test-gpu'), 'worker agent reports configured accelerators without shell probes');
      assert.ok(agentWorkerDetail.data.worker.modelInventory.some(m => m.name === 'configured-model'), 'worker agent reports configured model inventory');
      assert.ok(agentWorkerDetail.data.worker.modelInventory.some(m => m.name === 'llama3-test' && m.provider === 'ollama'), 'worker agent reports configured Ollama model');
      const ollamaProvider = agentWorkerDetail.data.worker.providers.find(p => p.type === 'ollama');
      assert.ok(ollamaProvider, 'worker agent reports configured Ollama backend');
      assert.ok(!JSON.stringify(ollamaProvider).includes('user:pass'), 'worker agent sanitizes backend endpoint credentials');
      assert.strictEqual(agentWorkerDetail.data.worker.health.protocolVersion, '1', 'worker agent reports protocol version in health');
    } finally {
      agent.kill('SIGTERM');
      await waitForExit(agent).catch(() => {});
    }
    assert.ok(!agentLogs.includes(agentToken.data.token), 'agent logs do not print enrollment token');

    const restartEnv = { ...agentEnv };
    delete restartEnv.SIDEKICK_ENROLL_TOKEN;
    restartEnv.SIDEKICK_WORKER_POLL_MS = '50';
    restartEnv.SIDEKICK_WORKER_SHUTDOWN_GRACE_MS = '3000';
    const restartedAgent = spawn(process.execPath, ['src/compute/worker-agent.js'], { cwd: path.join(__dirname, '..'), env: restartEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let restartLogs = '';
    restartedAgent.stdout.on('data', c => restartLogs += c.toString());
    restartedAgent.stderr.on('data', c => restartLogs += c.toString());
    const gracefulJob = await request('POST', '/compute/admin/jobs', { jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'graceful shutdown', delayMs: 500 } }, admin);
    assert.strictEqual(gracefulJob.status, 200, 'graceful-shutdown job submitted');
    await waitForJobStatus(gracefulJob.data.job.jobId, 'running', admin);
    restartedAgent.kill('SIGTERM');
    await waitForExit(restartedAgent, 5000);
    const completedGracefulJob = await waitForJobStatus(gracefulJob.data.job.jobId, 'completed', admin);
    assert.strictEqual(completedGracefulJob.result.content, 'mock:graceful shutdown', 'worker agent completed in-flight job during graceful shutdown');
    assert.ok(restartLogs.includes('Loaded worker credential'), 'worker agent restarted from saved credential config');
    assert.ok(!restartLogs.includes(agentToken.data.token), 'restart logs do not print enrollment token');

    const cancellingAgent = spawn(process.execPath, ['src/compute/worker-agent.js'], { cwd: path.join(__dirname, '..'), env: restartEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let cancellingLogs = '';
    cancellingAgent.stdout.on('data', c => cancellingLogs += c.toString());
    cancellingAgent.stderr.on('data', c => cancellingLogs += c.toString());
    try {
      const agentCancelJob = await request('POST', '/compute/admin/jobs', { jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'agent cancel', delayMs: 2000 } }, admin);
      assert.strictEqual(agentCancelJob.status, 200, 'agent cancellation job submitted');
      await waitForJobStatus(agentCancelJob.data.job.jobId, 'running', admin);
      const cancelAgentJob = await request('POST', `/compute/admin/jobs/${agentCancelJob.data.job.jobId}/cancel`, { reason: 'agent-cancel-test' }, admin);
      assert.strictEqual(cancelAgentJob.status, 200, 'agent running job cancelled');
      const ackedAgentJob = await waitForJobPredicate(agentCancelJob.data.job.jobId, admin, job => job.status === 'cancelled' && !!job.cancelAcknowledgedAt, 'cancellation acknowledgement');
      assert.strictEqual(ackedAgentJob.job.result, null, 'cancelled agent job has no result');
      assert.strictEqual(ackedAgentJob.artifacts.length, 0, 'cancelled agent job did not publish artifacts');
      assert.ok(cancellingLogs.includes('Acknowledged cancellation'), 'worker agent logged cancellation acknowledgement');
    } finally {
      cancellingAgent.kill('SIGTERM');
      await waitForExit(cancellingAgent).catch(() => {});
    }

    const revokeRes = await request('POST', `/compute/admin/workers/${workerId}/revoke`, { reason: 'test-revoke' }, admin);
    assert.strictEqual(revokeRes.status, 200, 'admin can revoke worker');
    assert.strictEqual(revokeRes.data.worker.state, 'revoked', 'worker revoked');
    assert.strictEqual((await request('POST', '/compute/worker/heartbeat', { currentJobs: 0 }, workerAuth)).status, 401, 'revoked worker credential rejected');

    assert.ok(!logs.includes(credential), 'worker credential not printed in server logs');
    assert.ok(!logs.includes(activeCredential), 'rotated worker credential not printed in server logs');
    assert.ok(!logs.includes(tokenRes.data.token), 'enrollment token not printed in server logs');
    console.log('Compute Protocol Integration Tests passed');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
