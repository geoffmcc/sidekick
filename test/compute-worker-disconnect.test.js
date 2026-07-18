// Phase 2 — worker-side graceful disconnect.
// Verifies the worker agent posts a bounded, best-effort disconnect to the
// server on shutdown, carrying worker auth and a reason, and that shutdown is
// idempotent. Uses a local capture server so no real enrollment is needed.
const assert = require('assert');
const http = require('http');

let captured = null;
let requestCount = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/compute/worker/disconnect') {
    requestCount++;
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      captured = { auth: req.headers.authorization, body: body ? JSON.parse(body) : {} };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, worker: { connectionState: 'offline' } }));
    });
  } else {
    res.writeHead(404); res.end();
  }
});

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); }
}

async function main() {
  console.log('Running Compute Worker Disconnect Tests...\n');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // SERVER_URL is read from env at module load, so set it before requiring.
  process.env.SIDEKICK_URL = `http://127.0.0.1:${port}`;
  const agent = require('../src/compute/worker-agent');

  // Without identity, disconnect is a silent no-op (no request sent).
  const noIdentity = await agent.sendDisconnect('no-identity');
  check('sendDisconnect no-ops without worker identity', noIdentity === false && captured === null);

  // With identity, disconnect posts with bearer auth and the reason.
  agent.__setWorkerIdentityForTest('wk_test', 'wksec_secret');
  const sent = await agent.sendDisconnect('unit-test');
  check('sendDisconnect returns true on HTTP 200', sent === true);
  check('disconnect carries worker bearer auth', captured && captured.auth === 'Bearer wk_test:wksec_secret');
  check('disconnect body carries reason', captured && captured.body.reason === 'unit-test');

  // requestShutdown triggers a disconnect tagged with the signal.
  captured = null;
  await agent.requestShutdown('SIGTERM');
  check('requestShutdown sends disconnect with signal reason', captured && captured.body.reason === 'worker_shutdown:SIGTERM');

  // requestShutdown is idempotent — a second call sends nothing.
  captured = null;
  const before = requestCount;
  await agent.requestShutdown('SIGINT');
  check('requestShutdown is idempotent', captured === null && requestCount === before);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
