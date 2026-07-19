// Phase 8 — dedicated minimal worker package.
// Runs the build script and asserts the artifact is complete, dependency-free,
// free of server-only code, integrity-manifested, and runnable standalone.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const VERSION = require(path.join(REPO, 'package.json')).version;
const OUT = path.join(REPO, 'dist', `sidekick-compute-worker-${VERSION}`);

console.log('Running Compute Worker Package Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${e.stack || e.message}`); }
}

// Build fresh.
execFileSync('node', ['scripts/build-worker-package.js'], { cwd: REPO, stdio: 'ignore' });

function listFiles(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}
const files = listFiles(OUT);

test('package.json is dependency-free with correct bin and engines', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.name, 'sidekick-compute-worker');
  assert.strictEqual(pkg.version, VERSION);
  assert.deepStrictEqual(pkg.dependencies, undefined, 'no dependencies field');
  assert.strictEqual(pkg.bin['sidekick-compute-worker'], 'worker-agent.js');
  assert.ok(/>=\s*22/.test(pkg.engines.node), 'engines node >=22');
});

test('includes the worker modules, OpenVINO helper, and service files', () => {
  const expected = [
    'worker-agent.js', 'worker-config.js', 'worker-credential.js', 'worker-cli.js', 'worker-reconnect.js',
    'openvino-executor.js', 'openvino/helper.py',
    'systemd/sidekick-compute-worker.service',
    'packaging/compute-worker/install-linux.sh', 'packaging/compute-worker/install-windows.ps1',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SHA256SUMS',
  ];
  for (const f of expected) assert.ok(files.includes(f), `missing ${f}`);
});

test('bundles the pinned, SHA-256-verified winsw as sidekick-compute-worker.exe', () => {
  // Pinned independently of the build script so a drive-by pin change there
  // fails here. winsw v2.12.0 WinSW.NET461.exe.
  const WINSW_SHA256 = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f';
  const exe = path.join(OUT, 'sidekick-compute-worker.exe');
  assert.ok(files.includes('sidekick-compute-worker.exe'), 'winsw exe missing from package root');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  assert.strictEqual(actual, WINSW_SHA256, 'bundled winsw hash does not match the pinned release');
  const notices = fs.readFileSync(path.join(OUT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.ok(notices.includes('WinSW'), 'packaged THIRD_PARTY_NOTICES.md lacks the WinSW entry');
});

test('excludes all server-only code', () => {
  const banned = ['index.js', 'dashboard.js', 'db.js', 'tools.js', 'tools-legacy.js', 'agent.js', 'job-manager.js', 'provider-registry.js'];
  for (const b of banned) assert.ok(!files.includes(b), `server-only file leaked: ${b}`);
  assert.ok(!files.some(f => f.startsWith('src/')), 'no src/ tree');
  assert.ok(!files.some(f => f.startsWith('migrations/')), 'no migrations');
  assert.ok(!files.some(f => f.startsWith('test/')), 'no tests');
});

test('SHA256SUMS matches actual file contents', () => {
  const manifest = fs.readFileSync(path.join(OUT, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const listed = new Set();
  for (const line of manifest) {
    const [hash, rel] = line.split(/\s{2,}/);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, rel))).digest('hex');
    assert.strictEqual(actual, hash, `hash mismatch for ${rel}`);
    listed.add(rel);
  }
  // Every packaged file except the manifest itself must be listed.
  for (const f of files) if (f !== 'SHA256SUMS') assert.ok(listed.has(f), `${f} not in SHA256SUMS`);
});

test('packaged worker runs standalone', () => {
  const out = execFileSync('node', [path.join(OUT, 'worker-agent.js'), 'version'], { encoding: 'utf8' }).trim();
  assert.strictEqual(out, VERSION, 'version command prints package version');
  const status = execFileSync('node', [path.join(OUT, 'worker-agent.js'), 'status'], {
    encoding: 'utf8', env: { ...process.env, SIDEKICK_WORKER_CONFIG: '/tmp/nonexistent-cred.json' },
  });
  assert.ok(status.includes('Enrolled:        no'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
