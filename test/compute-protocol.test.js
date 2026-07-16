const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

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

    const tokenRes = await request('POST', '/compute/enrollment-tokens', { displayName: 'http-worker', expiresInMs: 600000 }, admin);
    assert.strictEqual(tokenRes.status, 200, 'admin can create enrollment token');
    assert.ok(tokenRes.data.token && tokenRes.data.token.startsWith('enroll_'), 'token returned once');

    const enrollRes = await request('POST', '/compute/enroll', {
      token: tokenRes.data.token,
      nodeId: 'proto-node-1',
      displayName: 'Protocol Worker',
      platform: process.platform,
      executors: [{ type: 'mock.inference', capabilities: ['chat', 'generate', 'embeddings'] }],
      providers: [{ type: 'mock', endpoint: 'in-process' }],
      protocolVersion: '1',
    });
    assert.strictEqual(enrollRes.status, 200, 'worker enrolls');
    assert.ok(enrollRes.data.credential, 'persistent credential returned');
    const workerId = enrollRes.data.worker.workerId;
    const credential = enrollRes.data.credential;
    const workerAuth = { Authorization: `Bearer ${workerId}:${credential}` };

    const reuseRes = await request('POST', '/compute/enroll', { token: tokenRes.data.token, nodeId: 'proto-node-2', displayName: 'Reuse', platform: process.platform });
    assert.strictEqual(reuseRes.status, 400, 'enrollment token reuse rejected');
    assert.strictEqual((await request('POST', '/compute/heartbeat', { currentJobs: 0 }, { Authorization: `Bearer ${workerId}:bad` })).status, 401, 'bad worker credential rejected');
    assert.strictEqual((await request('POST', '/compute/heartbeat', { currentJobs: 0, executors: [{ type: 'mock.inference', capabilities: ['chat'] }] }, workerAuth)).status, 200, 'heartbeat accepted');

    const jobRes = await request('POST', '/compute/jobs', { jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'hello protocol' }, dataClassification: 'private' }, admin);
    assert.strictEqual(jobRes.status, 200, 'job submitted');

    const claimRes = await request('POST', '/compute/jobs/claim', { leaseDurationMs: 60000 }, workerAuth);
    assert.strictEqual(claimRes.status, 200, 'claim response ok');
    assert.strictEqual(claimRes.data.claimed, true, 'job claimed');
    const jobId = claimRes.data.job.jobId;
    const leaseId = claimRes.data.leaseId;

    const duplicateClaim = await Promise.all([
      request('POST', '/compute/jobs/claim', { leaseDurationMs: 60000 }, workerAuth),
      request('POST', '/compute/jobs/claim', { leaseDurationMs: 60000 }, workerAuth),
    ]);
    assert.ok(duplicateClaim.every(r => r.status === 200 && r.data.claimed === false), 'already claimed job is not double assigned');

    const startRes = await request('POST', `/compute/jobs/${jobId}/start`, { leaseId }, workerAuth);
    assert.strictEqual(startRes.status, 200, `start accepted: ${JSON.stringify(startRes.data)}`);
    assert.strictEqual((await request('POST', `/compute/jobs/${jobId}/renew`, { leaseId, leaseDurationMs: 60000 }, workerAuth)).status, 200, 'renew accepted');
    assert.strictEqual((await request('POST', `/compute/jobs/${jobId}/progress`, { leaseId, progressPercent: 55, progressMessage: 'halfway' }, workerAuth)).status, 200, 'progress accepted');

    const completeRes = await request('POST', `/compute/jobs/${jobId}/complete`, { leaseId, result: { content: 'mock:hello protocol' }, artifacts: [{ name: 'result.txt', content: 'mock:hello protocol', contentType: 'text/plain' }] }, workerAuth);
    assert.strictEqual(completeRes.status, 200, 'completion accepted');
    assert.strictEqual(completeRes.data.job.status, 'completed', 'job completed');

    const duplicateComplete = await request('POST', `/compute/jobs/${jobId}/complete`, { leaseId, result: { content: 'duplicate' } }, workerAuth);
    assert.strictEqual(duplicateComplete.status, 200, 'duplicate completion idempotent');
    assert.strictEqual(duplicateComplete.data.job.result.content, 'mock:hello protocol', 'duplicate completion did not overwrite result');

    const detail = await request('GET', `/compute/jobs/${jobId}`, null, admin);
    assert.strictEqual(detail.status, 200, 'job detail retrievable');
    assert.strictEqual(detail.data.job.status, 'completed', 'detail shows terminal state');
    assert.ok(detail.data.artifacts.length >= 1, 'artifact metadata recorded');

    await request('POST', '/compute/jobs', { jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'stale' }, maxAttempts: 1 }, admin);
    const staleClaim = await request('POST', '/compute/jobs/claim', { leaseDurationMs: 1 }, workerAuth);
    await new Promise(r => setTimeout(r, 20));
    const staleComplete = await request('POST', `/compute/jobs/${staleClaim.data.job.jobId}/complete`, { leaseId: staleClaim.data.leaseId, result: { content: 'too late' } }, workerAuth);
    assert.strictEqual(staleComplete.status, 409, 'stale lease completion rejected');
    const recover = await request('POST', '/compute/recover', {}, admin);
    assert.strictEqual(recover.status, 200, 'recovery endpoint works');
    assert.ok(recover.data.recovered >= 1, 'expired lease recovered');

    assert.ok(!logs.includes(credential), 'worker credential not printed in server logs');
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
