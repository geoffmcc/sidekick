// Phase 6 — worker run-loop resilience (integration).
// A controllable fake server drives the worker through a transient outage (must
// reconnect) and a permanent revocation (must stop cleanly). Credential is
// pre-written so the worker loads it and skips enrollment.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const AGENT = path.join(__dirname, '..', 'src', 'compute', 'worker-agent.js');
const cred = require('../src/compute/worker-credential');

let mode = 'ok'; // 'ok' | 'down' (503) | 'revoked' (401)
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj || {})); };
    if (req.url === '/health') return send(200, { ok: true });
    if (req.url === '/compute/worker/heartbeat' || req.url === '/compute/worker/jobs/claim') {
      if (mode === 'revoked') return send(401, { ok: false, error: 'worker authentication required' });
      if (mode === 'down') return send(503, { ok: false, error: 'server unavailable' });
      if (req.url.endsWith('/claim')) return send(200, { ok: true, claimed: false });
      return send(200, { ok: true, worker: {} });
    }
    return send(200, { ok: true });
  });
});

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function spawnWorker(credPath, port) {
  const child = spawn('node', [AGENT, 'run'], {
    env: {
      ...process.env,
      SIDEKICK_URL: `http://127.0.0.1:${port}`,
      SIDEKICK_WORKER_CONFIG: credPath,
      SIDEKICK_HEARTBEAT_MS: '1000',
      SIDEKICK_WORKER_POLL_MS: '500',
      SIDEKICK_WORKER_MAX_RETRY_MS: '2000',
      SIDEKICK_OPENVINO_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', c => { logs += c.toString(); });
  child.stderr.on('data', c => { logs += c.toString(); });
  return { child, getLogs: () => logs };
}
async function waitFor(getLogs, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getLogs().includes(needle)) return true;
    await sleep(150);
  }
  return false;
}
function waitExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', code => { clearTimeout(t); resolve(code === null ? 0 : code); });
  });
}

async function main() {
  console.log('Running Compute Worker Resilience Tests...\n');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wres-'));
  const credPath = path.join(TMP, 'worker-credential.json');
  cred.save({ workerId: 'wk_resil_test', nodeId: 'node_resil_test', credential: 'wksec_resiliencetest' }, credPath);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // --- Transient outage: worker must survive and reconnect ---
  mode = 'ok';
  let w = spawnWorker(credPath, port);
  const started = await waitFor(w.getLogs, 'Starting worker agent', 4000);
  check('worker started', started);
  await sleep(1500); // let it heartbeat successfully at least once
  mode = 'down';
  const lost = await waitFor(w.getLogs, 'Lost connection to server', 5000);
  check('logs "Lost connection" during transient outage', lost);
  check('worker still running during outage (did not exit)', w.child.exitCode === null);
  mode = 'ok';
  const reconnected = await waitFor(w.getLogs, 'Reconnected to server', 5000);
  check('logs "Reconnected" once the server returns', reconnected);
  w.child.kill('SIGTERM');
  await waitExit(w.child, 5000);

  // --- Permanent revocation: worker must stop cleanly ---
  mode = 'ok';
  w = spawnWorker(credPath, port);
  await waitFor(w.getLogs, 'Starting worker agent', 4000);
  await sleep(1200);
  mode = 'revoked';
  const exitCode = await waitExit(w.child, 6000);
  check('worker exits on permanent revocation', exitCode !== null);
  check('exits cleanly (code 0) to avoid restart hot-loop', exitCode === 0);
  check('logs a FATAL revocation message', w.getLogs().includes('FATAL') && /revoked or invalid/.test(w.getLogs()));
  if (w.child.exitCode === null) w.child.kill('SIGKILL');

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
