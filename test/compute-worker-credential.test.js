// Phase 4 — secure worker credential persistence (module-level).
// Atomic save, permission hardening, validation on load. Uses os.tmpdir (real
// POSIX perms) rather than the /mnt/c working tree (drvfs ignores chmod).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const cred = require('../src/compute/worker-credential');

console.log('Running Compute Worker Credential Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${e.stack || e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wcred-'));
let seq = 0;
const isWin = process.platform === 'win32';
function freshPath() {
  const directory = path.join(TMP, `sub-${++seq}`);
  fs.mkdirSync(directory, { recursive: true });
  if (isWin) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const whoami = path.join(systemRoot, 'System32', 'whoami.exe');
    const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
    const env = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, 'System32') };
    const identity = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, env }).trim();
    const sid = identity.match(/,\s*"(S-1-[0-9-]+)"\s*$/)?.[1];
    assert.ok(sid, 'test process SID is available');
    execFileSync(icacls, [directory, '/reset'], { stdio: 'ignore', windowsHide: true, env });
    execFileSync(icacls, [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], {
      stdio: 'ignore', windowsHide: true, env,
    });
  }
  return path.join(directory, 'worker-credential.json');
}

const record = { workerId: 'wk_abc123', nodeId: 'node_deadbeef00112233', credential: 'wksec_topsecretvalue' };

test('save then load round-trips the credential record', () => {
  const p = freshPath();
  cred.save(record, p);
  const loaded = cred.load(p);
  assert.strictEqual(loaded.workerId, record.workerId);
  assert.strictEqual(loaded.credential, record.credential);
  assert.strictEqual(loaded.nodeId, record.nodeId);
  assert.strictEqual(loaded.version, 1);
  assert.ok(loaded.enrolledAt, 'enrolledAt stamped');
});

test('save writes via temp+rename (no leftover temp file)', () => {
  const p = freshPath();
  cred.save(record, p);
  const dir = path.dirname(p);
  assert.deepStrictEqual(fs.readdirSync(dir), ['worker-credential.json'], 'only the final file remains');
});

test('save rejects a malformed record', () => {
  assert.throws(() => cred.save({ workerId: 'bad', credential: 'wksec_x' }, freshPath()), /malformed/);
  assert.throws(() => cred.save({ workerId: 'wk_ok', credential: 'nope' }, freshPath()), /malformed/);
});

test('Windows ACL helper children receive only a minimal system environment', () => {
  const env = cred.windowsSystemEnv('D:\\Windows');
  assert.strictEqual(env.SystemRoot, 'D:\\Windows');
  assert.strictEqual(env.WINDIR, 'D:\\Windows');
  assert.strictEqual(env.PATH, 'D:\\Windows\\System32');
  assert.strictEqual(env.SIDEKICK_NODE_ENROLL_TOKEN, undefined);
  assert.strictEqual(env.SIDEKICK_API_KEY, undefined);
});

test('load returns null for an absent file', () => {
  assert.strictEqual(cred.load(path.join(TMP, 'missing.json')), null);
});

test('load returns null for malformed content', () => {
  const p = freshPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ not json');
  assert.strictEqual(cred.load(p), null);
  fs.writeFileSync(p, JSON.stringify({ workerId: 'wk_ok', credential: 'not-a-secret' }));
  assert.strictEqual(cred.load(p), null, 'rejects bad credential shape');
});

test('save applies 0600 file / 0700 dir on POSIX', function () {
  if (isWin) { console.log('    (skipped on win32)'); return; }
  const p = freshPath();
  cred.save(record, p);
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600, 'file is 0600');
  assert.strictEqual(fs.statSync(path.dirname(p)).mode & 0o777, 0o700, 'dir is 0700');
});

test('load tightens loosened POSIX permissions in place', function () {
  if (isWin) { console.log('    (skipped on win32)'); return; }
  const p = freshPath();
  cred.save(record, p);
  fs.chmodSync(p, 0o644);
  cred.load(p);
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600, 're-tightened to 0600');
});

test('applyWindowsAcl is best-effort (returns false without throwing off-Windows)', function () {
  if (isWin) { console.log('    (skipped on win32)'); return; }
  const p = freshPath();
  cred.save(record, p);
  assert.strictEqual(cred.applyWindowsAcl(p), false);
});

test('Windows credential ACL grants the effective process SID and remains readable by that token', function () {
  if (!isWin) { console.log('    (skipped on win32)'); return; }
  const p = freshPath();
  cred.save(record, p);
  const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const identity = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim();
  const account = identity.match(/^"([^"]+)"/)?.[1];
  const sid = identity.match(/,\s*"(S-1-[0-9-]+)"\s*$/)?.[1];
  assert.ok(account && sid, 'whoami must return the effective process identity');
  const acl = execFileSync(icacls, [p], { encoding: 'utf8', windowsHide: true });
  assert.ok(acl.toLowerCase().includes(account.toLowerCase()), 'ACL explicitly grants the effective process account');
  assert.strictEqual(cred.load(p).credential, record.credential, 'current process token can read the ACL-protected credential');
  execFileSync(icacls, [p, '/grant', '*S-1-5-32-545:R'], { stdio: 'ignore', windowsHide: true });
  assert.strictEqual(cred.verifyWindowsAcl(p), false, 'untrusted BUILTIN\\Users read ACE is rejected');
  assert.strictEqual(cred.load(p), null, 'credential is not loaded while its ACL is unsafe');
  cred.remove(p);
  cred.save(record, p);
  assert.strictEqual(cred.load(p).credential, record.credential, 'credential can be safely re-enrolled after an ACL violation');
});

// --- remove / park / restore / discard (re-enrollment support) ---

test('remove deletes the credential and reports whether one was there', () => {
  const p = freshPath();
  cred.save(record, p);
  assert.strictEqual(cred.remove(p), true, 'reports the removal');
  assert.strictEqual(fs.existsSync(p), false, 'file is gone');
  assert.strictEqual(cred.load(p), null, 'no longer loadable');
  assert.strictEqual(cred.remove(p), false, 'absent file is not an error');
});

test('park moves the credential aside so load no longer sees it', () => {
  const p = freshPath();
  cred.save(record, p);
  const parked = cred.park(p);
  assert.ok(parked && parked !== p, 'returns a distinct parked path');
  assert.strictEqual(fs.existsSync(p), false, 'original path is clear for re-enrollment');
  assert.strictEqual(cred.load(p), null);
  assert.ok(fs.existsSync(parked), 'parked copy is retained');
});

test('park returns null when there is nothing to park', () => {
  assert.strictEqual(cred.park(path.join(TMP, 'nothing-here.json')), null);
});

test('restore puts a parked credential back intact', () => {
  const p = freshPath();
  cred.save(record, p);
  const parked = cred.park(p);
  assert.strictEqual(cred.restore(parked, p), true);
  const loaded = cred.load(p);
  assert.ok(loaded, 'credential is loadable again');
  assert.strictEqual(loaded.credential, record.credential, 'secret survived the round trip');
  assert.strictEqual(fs.existsSync(parked), false, 'parked copy no longer lingers');
});

test('restore and discard are no-ops for a null parked path', () => {
  assert.strictEqual(cred.restore(null, freshPath()), false);
  assert.strictEqual(cred.discard(null), false);
});

test('discard deletes the parked credential so the secret does not linger', () => {
  const p = freshPath();
  cred.save(record, p);
  const parked = cred.park(p);
  assert.strictEqual(cred.discard(parked), true);
  assert.strictEqual(fs.existsSync(parked), false);
  assert.strictEqual(cred.discard(parked), false, 'second discard is not an error');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
