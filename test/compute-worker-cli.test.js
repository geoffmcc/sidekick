// Phase 5 — worker CLI parsing, status formatting, and binary dispatch.
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const cli = require('../src/compute/worker-cli');
const AGENT = path.join(__dirname, '..', 'src', 'compute', 'worker-agent.js');

console.log('Running Compute Worker CLI Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${e.stack || e.message}`); }
}

// --- parseArgv ---
test('defaults to the run command', () => {
  assert.strictEqual(cli.parseArgv([]).command, 'run');
});
test('recognizes each subcommand', () => {
  for (const c of ['run', 'enroll', 'status', 'doctor', 'rotate-credential', 'version']) {
    assert.strictEqual(cli.parseArgv([c]).command, c);
  }
});
test('maps flags to environment assignments', () => {
  const r = cli.parseArgv(['run', '--server', 'http://h:4097', '--node-id', 'node_x', '--config-file', '/tmp/c.json', '--concurrency', '4']);
  assert.strictEqual(r.env.SIDEKICK_SERVER_URL, 'http://h:4097');
  assert.strictEqual(r.env.SIDEKICK_NODE_ID, 'node_x');
  assert.strictEqual(r.env.SIDEKICK_WORKER_CONFIG_FILE, '/tmp/c.json');
  assert.strictEqual(r.env.SIDEKICK_WORKER_CONCURRENCY, '4');
  assert.strictEqual(r.error, null);
});
test('flags before an explicit command still parse', () => {
  const r = cli.parseArgv(['enroll', '--token', 'enroll_abc']);
  assert.strictEqual(r.command, 'enroll');
  assert.strictEqual(r.env.SIDEKICK_ENROLL_TOKEN, 'enroll_abc');
});
test('--service sets service flag (bare and with a type value)', () => {
  assert.strictEqual(cli.parseArgv(['enroll', '--service']).service, true);
  const withType = cli.parseArgv(['enroll', '--service', 'windows', '--token', 'enroll_x']);
  assert.strictEqual(withType.service, true);
  assert.strictEqual(withType.env.SIDEKICK_ENROLL_TOKEN, 'enroll_x', 'service type value consumed, token still parsed');
});
test('unknown command is an error', () => {
  assert.match(cli.parseArgv(['frobnicate']).error, /Unknown worker command/);
});
test('unknown option is an error', () => {
  assert.match(cli.parseArgv(['run', '--bogus', 'x']).error, /Unknown option/);
});
test('missing flag value is an error', () => {
  assert.match(cli.parseArgv(['run', '--server']).error, /Missing value/);
});
test('--help sets help', () => {
  assert.strictEqual(cli.parseArgv(['--help']).help, true);
  assert.strictEqual(cli.parseArgv(['-h']).help, true);
});

// --- formatStatus (redaction safety) ---
test('formatStatus renders fields and never leaks a secret', () => {
  const out = cli.formatStatus({
    serverUrl: 'http://h:4097', nodeId: 'node_x', displayName: 'W', configFilePath: '/c.json',
    credentialPath: '/cred.json', enrolled: true, workerId: 'wk_abc', enrolledAt: '2026-01-01T00:00:00Z', concurrency: 2,
  });
  assert.ok(out.includes('wk_abc') && out.includes('node_x') && out.includes('Enrolled:        yes'));
  assert.ok(!/wksec_/.test(out), 'no credential secret in output');
});
test('formatStatus omits worker id when not enrolled', () => {
  const out = cli.formatStatus({ serverUrl: 'x', nodeId: 'n', displayName: 'W', configFilePath: 'c', credentialPath: 'p', enrolled: false });
  assert.ok(out.includes('Enrolled:        no'));
  assert.ok(!out.includes('Worker ID'));
});

// --- binary dispatch (spawns the actual worker binary; no server needed) ---
test('binary: version prints the worker version', () => {
  const out = execFileSync('node', [AGENT, 'version'], { encoding: 'utf8' }).trim();
  assert.match(out, /^\d+\.\d+\.\d+/);
});
test('binary: status prints without secrets and exit 0', () => {
  const out = execFileSync('node', [AGENT, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, SIDEKICK_WORKER_CONFIG: '/tmp/does-not-exist-cred.json' },
  });
  assert.ok(out.includes('Enrolled:        no'));
  assert.ok(!/wksec_/.test(out));
});
test('binary: unknown command exits non-zero', () => {
  let code = 0;
  try { execFileSync('node', [AGENT, 'frobnicate'], { stdio: 'ignore' }); }
  catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
