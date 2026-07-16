const assert = require('assert');
const http = require('http');
const https = require('https');

const enabled = process.env.SIDEKICK_COMPUTE_LIVE === '1';
if (!enabled) {
  console.log('Compute live worker test skipped; set SIDEKICK_COMPUTE_LIVE=1 to enable.');
  process.exit(0);
}

const baseUrl = process.env.SIDEKICK_COMPUTE_LIVE_URL || process.env.SIDEKICK_URL;
const apiKey = process.env.SIDEKICK_COMPUTE_LIVE_API_KEY || process.env.SIDEKICK_API_KEY;
const timeoutMs = Number(process.env.SIDEKICK_COMPUTE_LIVE_TIMEOUT_MS || 60000);
const prompt = process.env.SIDEKICK_COMPUTE_LIVE_PROMPT || 'Sidekick live compute smoke test. Reply briefly with sidekick-live-smoke.';

if (!baseUrl || !apiKey) {
  throw new Error('SIDEKICK_COMPUTE_LIVE_URL and SIDEKICK_COMPUTE_LIVE_API_KEY are required when SIDEKICK_COMPUTE_LIVE=1');
}

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const data = body ? JSON.stringify(body) : null;
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('Running opt-in Compute Live Worker Test...');
  const created = await request('POST', '/compute/admin/jobs', {
    jobType: 'chat',
    capability: 'chat',
    requestPayload: { prompt },
    dataClassification: 'private',
    maxAttempts: 1,
    timeoutMs,
  });
  assert.strictEqual(created.status, 200, `live job create failed: ${JSON.stringify(created.data)}`);
  const jobId = created.data.job.jobId;
  const deadline = Date.now() + timeoutMs;
  let detail;
  while (Date.now() < deadline) {
    const res = await request('GET', `/compute/admin/jobs/${jobId}`);
    assert.strictEqual(res.status, 200, `live job detail failed: ${JSON.stringify(res.data)}`);
    detail = res.data;
    if (detail.job.status === 'completed') break;
    if (['failed', 'dead_letter', 'cancelled', 'expired'].includes(detail.job.status)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!detail || detail.job.status !== 'completed') {
    await request('POST', `/compute/admin/jobs/${jobId}/cancel`, { reason: 'live-smoke-timeout-cleanup' }).catch(() => {});
  }
  assert.ok(detail, 'live job detail should be available');
  assert.strictEqual(detail.job.status, 'completed', `live job did not complete: ${detail.job.status}`);
  assert.ok(detail.job.selectedWorkerId, 'live job should identify the worker that ran it');
  assert.ok(detail.job.result, 'live job should include a result');
  assert.ok((detail.artifacts || []).length >= 1, 'live job should publish an artifact');
  console.log(`Compute live worker test passed on worker ${detail.job.selectedWorkerId}`);
}

main().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
