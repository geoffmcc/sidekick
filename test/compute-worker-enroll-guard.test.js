// Enrollment guard: `enroll --token` must not silently keep a credential that
// the server no longer accepts (the failure that made a revoked worker exit 0
// forever), and must not destroy a valid one when the server is merely
// unreachable. Drives the real CLI against a stub server.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const cred = require('../src/compute/worker-credential');
const AGENT = path.join(__dirname, '..', 'src', 'compute', 'worker-agent.js');

console.log('Running Compute Worker Enroll Guard Tests...\n');

let passed = 0;
let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(['ok', name]); }
  catch (e) { failed++; results.push(['fail', name, e.stack || e.message]); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wenroll-'));
let seq = 0;
const freshPath = () => path.join(TMP, `sub-${++seq}`, 'credential.json');

const OLD = { workerId: 'wk_old111', nodeId: 'node_aaaabbbbccccdddd', credential: 'wksec_oldsecretvalue' };
const NEW_SECRET = 'wksec_freshsecretvalue';
const TOKEN = 'enroll_deadbeef_0123456789abcdef';

// Stub server. `plan` is swapped per test.
let plan = {};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj || {}));
    };
    if (req.url === '/compute/worker/heartbeat') {
      plan.heartbeatBodies = plan.heartbeatBodies || [];
      plan.heartbeatBodies.push(body);
      return send(plan.heartbeat, plan.heartbeat === 200 ? { ok: true } : { error: 'nope' });
    }
    if (req.url === '/compute/enrollment/exchange') {
      plan.exchangeCalls = (plan.exchangeCalls || 0) + 1;
      if (plan.exchange !== 200) return send(plan.exchange || 400, { ok: false, error: 'token expired' });
      return send(200, { ok: true, worker: { workerId: 'wk_new222', nodeId: OLD.nodeId }, credential: NEW_SECRET });
    }
    send(404, { error: 'not found' });
  });
});

function runEnroll(credPath) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      AGENT, 'enroll', '--service',
      '--server', `http://127.0.0.1:${server.address().port}`,
      '--token', TOKEN,
      '--config', credPath,
      '--config-file', path.join(TMP, 'no-such-config.json'),
    ], { env: { ...process.env, SIDEKICK_ENROLL_TOKEN: '', SIDEKICK_WORKER_CONFIG: credPath } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  await test('a still-valid credential is kept and the token goes unused', async () => {
    const p = freshPath();
    cred.save(OLD, p);
    plan = { heartbeat: 200 };
    const r = await runEnroll(p);
    assert.strictEqual(r.code, 0, `expected success, got ${r.code}: ${r.out}`);
    assert.match(r.out, /Already enrolled/, 'should report the existing enrollment');
    assert.strictEqual(cred.load(p).credential, OLD.credential, 'credential untouched');
    assert.ok(!plan.exchangeCalls, 'enrollment token must not be spent');
  });

  await test('the verification probe does not report a job count', async () => {
    const p = freshPath();
    cred.save(OLD, p);
    plan = { heartbeat: 200 };
    await runEnroll(p);
    const sent = JSON.parse(plan.heartbeatBodies[0] || '{}');
    assert.strictEqual(sent.currentJobs, undefined,
      'probe must not zero the job count of a worker already running on this machine');
  });

  await test('a rejected (revoked) credential is replaced using the token', async () => {
    const p = freshPath();
    cred.save(OLD, p);
    plan = { heartbeat: 401, exchange: 200 };
    const r = await runEnroll(p);
    assert.strictEqual(r.code, 0, `expected success, got ${r.code}: ${r.out}`);
    assert.strictEqual(plan.exchangeCalls, 1, 'token must be exchanged exactly once');
    const loaded = cred.load(p);
    assert.strictEqual(loaded.credential, NEW_SECRET, 'fresh credential persisted');
    assert.strictEqual(loaded.workerId, 'wk_new222', 'new worker identity persisted');
    assert.ok(!fs.existsSync(`${p}.rejected`), 'the superseded credential must not linger on disk');
  });

  await test('an unreachable/erroring server never discards the credential', async () => {
    const p = freshPath();
    cred.save(OLD, p);
    plan = { heartbeat: 500 };
    const r = await runEnroll(p);
    assert.notStrictEqual(r.code, 0, 'must fail loudly');
    assert.match(r.out, /Refusing to discard it/, 'must explain why it stopped');
    assert.strictEqual(cred.load(p).credential, OLD.credential, 'credential survives');
    assert.ok(!plan.exchangeCalls, 'must not spend the token on an unverified state');
  });

  await test('a 403 from an intermediary is not treated as revocation', async () => {
    const p = freshPath();
    cred.save(OLD, p);
    plan = { heartbeat: 403 };
    const r = await runEnroll(p);
    assert.notStrictEqual(r.code, 0, 'must not proceed');
    assert.strictEqual(cred.load(p).credential, OLD.credential,
      'a proxy/WAF 403 must not destroy a valid credential');
  });

  await test('a failed re-enrollment restores the parked credential', async () => {
    const p = freshPath();
    cred.save(OLD, p);
    plan = { heartbeat: 401, exchange: 400 };
    const r = await runEnroll(p);
    assert.notStrictEqual(r.code, 0, 'must fail loudly');
    const loaded = cred.load(p);
    assert.ok(loaded, 'machine must not be left with no credential at all');
    assert.strictEqual(loaded.credential, OLD.credential, 'the old credential is back in place');
    assert.ok(!fs.existsSync(`${p}.rejected`), 'no parked leftover');
  });

  await test('enrolling with no existing credential still works', async () => {
    const p = freshPath();
    plan = { heartbeat: 401, exchange: 200 };
    const r = await runEnroll(p);
    assert.strictEqual(r.code, 0, `expected success, got ${r.code}: ${r.out}`);
    assert.strictEqual(cred.load(p).credential, NEW_SECRET);
    assert.ok(!plan.heartbeatBodies, 'no credential to verify, so no probe');
  });

  await test('no secret or token is echoed to the console', async () => {
    const p = freshPath();
    cred.save(OLD, p);
    plan = { heartbeat: 401, exchange: 200 };
    const r = await runEnroll(p);
    assert.ok(!r.out.includes(OLD.credential), 'old secret must not be printed');
    assert.ok(!r.out.includes(NEW_SECRET), 'new secret must not be printed');
    assert.ok(!r.out.includes(TOKEN), 'enrollment token must not be printed');
  });

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const [status, name, detail] of results) {
    if (status === 'ok') console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    else { console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${detail}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
