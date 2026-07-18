// Phase 4 — worker-side safe credential rotation workflow.
// Verifies rotateWorkerCredential() authenticates with the OLD credential,
// persists the NEW one atomically, and verifies it with a heartbeat. Uses a
// local capture server and a temp credential path.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cred = require('../src/compute/worker-credential');

let captured = {};
let failRotate = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.url === '/compute/worker/credentials/rotate') {
      captured.rotateAuth = req.headers.authorization;
      if (failRotate) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'nope' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, worker: { workerId: 'wk_rotatetest', nodeId: 'node_rotate' }, credential: 'wksec_rotatednewvalue', credentialType: 'worker-bearer-v1' }));
    } else if (req.url === '/compute/worker/heartbeat') {
      captured.heartbeatAuth = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, worker: {} }));
    } else { res.writeHead(404); res.end(); }
  });
});

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); }
}

async function main() {
  console.log('Running Compute Worker Rotate Tests...\n');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wrot-'));
  const credPath = path.join(TMP, 'worker-credential.json');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.SIDEKICK_URL = `http://127.0.0.1:${port}`;
  process.env.SIDEKICK_WORKER_CONFIG = credPath;
  const agent = require('../src/compute/worker-agent');

  // Failure path first: rotation error throws and never touches on-disk credential.
  failRotate = true;
  agent.__setWorkerIdentityForTest('wk_rotatetest', 'wksec_oldvalue');
  let threw = false;
  try { await agent.rotateWorkerCredential(); } catch { threw = true; }
  check('rotation failure throws', threw);
  check('no credential written on failed rotation', !fs.existsSync(credPath));

  // Success path.
  failRotate = false;
  captured = {};
  agent.__setWorkerIdentityForTest('wk_rotatetest', 'wksec_oldvalue');
  const result = await agent.rotateWorkerCredential();
  check('rotateWorkerCredential returns true', result === true);
  check('rotate request used the OLD credential', captured.rotateAuth === 'Bearer wk_rotatetest:wksec_oldvalue');
  const saved = cred.load(credPath);
  check('new credential persisted to disk', saved && saved.credential === 'wksec_rotatednewvalue');
  check('verification heartbeat used the NEW credential', captured.heartbeatAuth === 'Bearer wk_rotatetest:wksec_rotatednewvalue');

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
