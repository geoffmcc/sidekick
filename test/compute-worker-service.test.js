// Phase 7 — OS service integration: static validation of service definitions
// and installer scripts (live registration is Phase 11 acceptance).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'packaging', 'compute-worker');
const read = p => fs.readFileSync(p, 'utf8');

console.log('Running Compute Worker Service Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${e.stack || e.message}`); }
}

const unit = read(path.join(ROOT, 'systemd', 'sidekick-compute-worker.service'));
const plist = read(path.join(PKG, 'com.sidekick.compute-worker.plist'));
const winsw = read(path.join(PKG, 'sidekick-compute-worker.xml'));

// --- systemd ---
test('systemd unit has the three sections', () => {
  for (const s of ['[Unit]', '[Service]', '[Install]']) assert.ok(unit.includes(s), `missing ${s}`);
});
test('systemd restarts on-failure only (not always)', () => {
  assert.ok(/^Restart=on-failure$/m.test(unit), 'Restart=on-failure');
  assert.ok(!/^Restart=always/m.test(unit), 'must not set Restart=always');
});
test('systemd ExecStart runs the worker "run" command', () => {
  assert.ok(/ExecStart=.*worker-agent\.js run\s*$/m.test(unit));
});
test('systemd targets multi-user and references the config paths', () => {
  assert.ok(/WantedBy=multi-user\.target/.test(unit));
  assert.ok(unit.includes('SIDEKICK_WORKER_CONFIG'));
});

// --- launchd ---
test('launchd plist is well-formed and labeled', () => {
  assert.ok(plist.startsWith('<?xml'));
  assert.ok(/<plist[\s\S]*<\/plist>\s*$/.test(plist));
  assert.ok(/<key>Label<\/key>\s*<string>com\.sidekick\.compute-worker<\/string>/.test(plist));
});
test('launchd restarts on abnormal exit only', () => {
  assert.ok(/<key>KeepAlive<\/key>/.test(plist));
  assert.ok(/<key>SuccessfulExit<\/key>\s*<false\/>/.test(plist), 'SuccessfulExit must be false');
  assert.ok(/<key>RunAtLoad<\/key>\s*<true\/>/.test(plist));
});
test('launchd runs the worker "run" command', () => {
  assert.ok(/<string>run<\/string>/.test(plist));
});

// --- winsw ---
test('winsw definition is well-formed with the right id and restart policy', () => {
  assert.ok(/<service>[\s\S]*<\/service>\s*$/.test(winsw));
  assert.ok(/<id>sidekick-compute-worker<\/id>/.test(winsw));
  assert.ok(/<arguments>worker-agent\.js run<\/arguments>/.test(winsw));
  assert.ok(/<onfailure action="restart"/.test(winsw));
});

// --- installers ---
const shInstallers = ['install-linux.sh', 'uninstall-linux.sh', 'install-macos.sh', 'uninstall-macos.sh'];
const psInstallers = ['install-windows.ps1', 'uninstall-windows.ps1'];

test('shell installers are syntactically valid (bash -n) and strict-mode', () => {
  for (const f of shInstallers) {
    const p = path.join(PKG, f);
    execFileSync('bash', ['-n', p]);
    assert.ok(/set -euo pipefail/.test(read(p)), `${f} missing strict mode`);
  }
});
test('installers enroll via --service and never embed a token literal', () => {
  for (const f of [...shInstallers, ...psInstallers]) {
    const body = read(path.join(PKG, f));
    if (f.startsWith('install-')) assert.ok(/enroll --service/.test(body), `${f} should enroll --service`);
    // token must come from a variable, never a hardcoded value
    assert.ok(!/enroll_[0-9a-f]{8,}/.test(body), `${f} contains a token literal`);
    assert.ok(!/wksec_/.test(body), `${f} contains a credential literal`);
  }
});
test('no service definition embeds a secret', () => {
  for (const body of [unit, plist, winsw]) {
    assert.ok(!/wksec_|enroll_[0-9a-f]{8,}/.test(body), 'service definition must not contain secrets');
    assert.ok(!/--token/.test(body), 'service definition must not pass an enrollment token');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
