// Phase 11 — end-to-end acceptance: the worker CLI driven against a real server
// through the full credential lifecycle (enroll → status → doctor → rotate →
// revoke → re-enroll). Non-critical in run-all (spawns a server; re-run once if
// the spawn is slow under WSL). Online/offline + reconnect transitions are
// covered by the protocol and resilience suites.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'src', 'compute', 'worker-agent.js');
const PORT = 47399;
const API_KEY = 'sk-e2e-worker-key';
const admin = { Authorization: `Bearer ${API_KEY}` };
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-srv-'));
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-wrk-'));
const CRED = path.join(WORK_DIR, 'worker-credential.json');
const NODE_ID = 'node_e2e_worker_01';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'Content-Type': 'application/json', ...admin, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let t = ''; res.on('data', c => t += c); res.on('end', () => resolve({ status: res.statusCode, data: t ? JSON.parse(t) : {} })); });
    r.on('error', reject); r.setTimeout(5000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data); r.end();
  });
}
const cliEnv = { ...process.env, SIDEKICK_URL: `http://127.0.0.1:${PORT}`, SIDEKICK_WORKER_CONFIG: CRED, SIDEKICK_NODE_ID: NODE_ID, SIDEKICK_NODE_NAME: 'e2e-worker' };
function cli(args, expectFail = false) {
  try { return execFileSync('node', [AGENT, ...args], { encoding: 'utf8', env: cliEnv }); }
  catch (e) { if (expectFail) return (e.stdout || '') + (e.stderr || ''); throw e; }
}

async function main() {
  console.log('Running Compute Worker E2E Acceptance Tests...\n');
  const server = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, SIDEKICK_DATA_DIR: DATA_DIR, SIDEKICK_PORT: String(PORT), SIDEKICK_API_KEY: API_KEY } });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch {} await sleep(250); }

    // status before enrollment
    check('status reports not enrolled before enroll', /Enrolled:\s+no/.test(cli(['status'])));

    // enroll
    const tok = await req('POST', '/compute/enrollment/tokens', { displayName: 'e2e-worker', expiresInMs: 600000 });
    cli(['enroll', '--service', '--token', tok.data.token]);
    check('credential file written', fs.existsSync(CRED));
    if (process.platform !== 'win32') check('credential file is 0600', (fs.statSync(CRED).mode & 0o777) === 0o600);
    else check('credential file is 0600 (skipped on win32)', true);

    // status + doctor after enrollment
    check('status reports enrolled with a worker id', /Enrolled:\s+yes/.test(cli(['status'])) && /Worker ID:\s+wk_/.test(cli(['status'])));
    check('doctor reports authenticated heartbeat', /Authenticated heartbeat succeeded/.test(cli(['doctor'])));

    // rotate
    const before = JSON.parse(fs.readFileSync(CRED, 'utf8')).credential;
    cli(['rotate-credential']);
    const after = JSON.parse(fs.readFileSync(CRED, 'utf8')).credential;
    check('rotate-credential changes the on-disk credential', before !== after && /^wksec_/.test(after));
    check('doctor still healthy after rotation', /Authenticated heartbeat succeeded/.test(cli(['doctor'])));

    // revoke -> doctor auth fails
    const worker = (await req('GET', '/compute/admin/workers')).data.workers.find(w => w.nodeId === NODE_ID);
    await req('POST', `/compute/admin/workers/${worker.workerId}/revoke`, { reason: 'e2e' });
    check('doctor reports auth rejected after revoke', /rejected \(401\)/.test(cli(['doctor'], true)));

    // re-enroll (recover): remove local credential, use a node-scoped token
    fs.rmSync(CRED, { force: true });
    const reTok = await req('POST', '/compute/enrollment/tokens', { displayName: 'e2e-reenroll', expiresInMs: 600000, reEnrollmentOf: NODE_ID });
    cli(['enroll', '--service', '--token', reTok.data.token]);
    check('re-enroll restores an authenticated worker', /Authenticated heartbeat succeeded/.test(cli(['doctor'])));
    const recovered = (await req('GET', '/compute/admin/workers')).data.workers.find(w => w.nodeId === NODE_ID);
    check('recovered worker credential is active again', recovered && recovered.credentialState === 'active');
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
