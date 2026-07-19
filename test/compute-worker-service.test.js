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
test('windows installer verifies any -WinswUrl download (https + SHA-256)', () => {
  const body = read(path.join(PKG, 'install-windows.ps1'));
  assert.ok(/Scheme -ne "https"/.test(body), 'must reject non-https -WinswUrl');
  assert.ok(/Get-FileHash -Algorithm SHA256/.test(body), 'must hash the downloaded winsw');
  assert.ok(/SHA-256 mismatch/.test(body), 'must fail closed on hash mismatch');
  assert.ok(/b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f/.test(body), 'default -WinswSha256 must be the pinned winsw v2.12.0 hash');
});
test('windows installer resolves node to an absolute path and patches the XML', () => {
  const body = read(path.join(PKG, 'install-windows.ps1'));
  assert.ok(/Get-Command node/.test(body), 'must look up node');
  assert.ok(/\$NodeExe\s*=\s*\$NodeCmd\.Source/.test(body), 'must resolve node to its Source path');
  assert.ok(/Could not resolve node to an absolute path/.test(body), 'must fail closed when node cannot be resolved');
  assert.ok(/SelectSingleNode\("executable"\)\.InnerText\s*=\s*\$NodeExe/.test(body), 'must patch <executable> with the resolved path');
});
test('windows installer is idempotent when the service already exists', () => {
  const body = read(path.join(PKG, 'install-windows.ps1'));
  assert.ok(/Get-Service -Name \$ServiceId/.test(body), 'must probe for an existing service');
  assert.ok(/\$ScExe delete \$ServiceId/.test(body), 'must be able to remove an orphaned registration');
  assert.ok(/still exists after removal/.test(body), 'must fail closed if removal did not take');
  // Removal has to precede the file copy: the running winsw binary is locked.
  assert.ok(body.indexOf('Get-Service -Name $ServiceId') < body.indexOf('Installing worker files'),
    'service removal must come before the file copy');
});
test('credential ACL grants LocalSystem read so the service can start', () => {
  const body = read(path.join(ROOT, 'src', 'compute', 'worker-credential.js'));
  assert.ok(/S-1-5-18/.test(body), 'must grant the LocalSystem SID (locale-independent)');
  assert.ok(/\/inheritance:r/.test(body), 'must still drop inherited ACEs');
  assert.ok(/\$\{user\}:F/.test(body), 'must still grant the installing user full control');
});
test('enroll verifies an existing credential instead of silently keeping it', () => {
  const body = read(path.join(ROOT, 'src', 'compute', 'worker-agent.js'));
  assert.ok(/async function credentialAccepted/.test(body), 'must have a credential check');
  assert.ok(/Refusing to discard it/.test(body), 'an unreachable server must not discard the credential');
  assert.ok(/workerCredential\.park\(CONFIG_PATH\)/.test(body), 'a rejected credential must be parked, not deleted outright');
  assert.ok(/workerCredential\.restore\(parked/.test(body), 'a failed re-enrollment must restore the parked credential');
});
test('windows installer refuses a non-admin-writable node.exe', () => {
  const body = read(path.join(PKG, 'install-windows.ps1'));
  assert.ok(/Get-NonAdminWriters/.test(body), 'must check who can write the resolved node.exe');
  assert.ok(/S-1-5-32-544/.test(body), 'must treat Administrators as trusted');
  assert.ok(/Refusing to install/.test(body), 'must fail closed by default');
  assert.ok(/AllowUserWritableNode/.test(body), 'must offer an explicit opt-in override');
  const rights = /\$UnsafeRights = .*?"([^"]+)"/.exec(body);
  assert.ok(rights, 'must declare the rights it treats as unsafe');
  assert.ok(!/\bRead\b|ReadAndExecute|ExecuteFile/.test(rights[1]),
    'read/execute rights must not be flagged as unsafe (every ACL grants them)');
  assert.ok(/ChangePermissions/.test(rights[1]) && /TakeOwnership/.test(rights[1]),
    'must catch ACL-rewrite rights, not just direct writes');
});
test('elevated installer paths do not resolve system binaries by bare name', () => {
  const ps = read(path.join(PKG, 'install-windows.ps1'));
  assert.ok(!/&\s*sc\.exe/.test(ps), 'sc.exe must be called by absolute path');
  assert.ok(!/&\s*node\s/.test(ps), 'node must be called via the validated $NodeExe');
  const cred = read(path.join(ROOT, 'src', 'compute', 'worker-credential.js'));
  assert.ok(!/execFileSync\("icacls"/.test(cred), 'icacls must be called by absolute path');
  assert.ok(/System32", "icacls\.exe"/.test(cred), 'icacls must resolve under System32');
});
test('no service definition embeds a secret', () => {
  for (const body of [unit, plist, winsw]) {
    assert.ok(!/wksec_|enroll_[0-9a-f]{8,}/.test(body), 'service definition must not contain secrets');
    assert.ok(!/--token/.test(body), 'service definition must not pass an enrollment token');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
