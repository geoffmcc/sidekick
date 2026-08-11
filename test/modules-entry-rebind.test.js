// Builtin module entry-hash re-binding (data-utilities #217 regression).
//
// A shipped builtin's entry file can legitimately change across releases,
// changing its content hash. The registered entry_hash is write-once, so
// before this fix the builtin failed closed into `error` forever after any such
// release (this is exactly what #217 did to data-utilities by adding a
// healthCheck). Provisioning now re-binds a drifted builtin hash to the current
// on-disk entry and recovers the stale-binding error — scoped to builtins only.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-modules-entry-rebind');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'modules-entry-rebind-test-secret-key';
delete process.env.SIDEKICK_BLOCKED_TOOLS;

function freshRequire() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](db\.js|tools-legacy\.js|modules[\\/]|tools[\\/])/.test(key)) {
      delete require.cache[key];
    }
  }
  return {
    dbStore: require('../src/db'),
    tools: require('../src/tools'),
    repository: require('../src/modules/repository'),
    builtinModules: require('../src/modules/builtin-modules'),
  };
}

let { dbStore, tools, repository, builtinModules } = freshRequire();
const DATA_UTILITY_TOOLS = ['parse', 'extract', 'transform', 'diff', 'validate', 'template'];
const WRONG_HASH = 'a'.repeat(64);

function transitionEvents() {
  return dbStore.getDb()
    .prepare("SELECT payload_json FROM platform_execution_events WHERE event_type = 'module.transition' ORDER BY rowid")
    .all()
    .map(r => JSON.parse(r.payload_json));
}

console.log('Running Builtin Module Entry-Rebind Tests...\n');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

dbStore.runPendingMigrations();

// Baseline: normal provisioning enables the module with the true entry hash.
const first = builtinModules.provisionBuiltinModules();
assert.deepStrictEqual(first.errors, [], `baseline provisioning must succeed: ${JSON.stringify(first.errors)}`);
const trueHash = repository.getModule('data-utilities').entry_hash;
assert.ok(/^[a-f0-9]{64}$/.test(trueHash), 'baseline should record a real entry hash');

// MER.1 — a drifted builtin hash in error state is re-bound and recovered.
test('MER.1 provisioning re-binds a drifted builtin hash and recovers', () => {
  // Simulate the post-#217 state: the on-disk entry changed (so the stored hash
  // is now stale) and the module failed closed into error.
  dbStore.getDb()
    .prepare("UPDATE platform_modules SET entry_hash = ?, state = 'error', error = 'entry-code binding does not match' WHERE name = 'data-utilities'")
    .run(WRONG_HASH);
  const before = repository.getModule('data-utilities');
  assert.strictEqual(before.state, 'error', 'precondition: module is in error');

  // Simulate a process restart: fresh module instances (empty in-memory active
  // set) reading the same persisted database. This mirrors the real deploy path
  // where the mcp service restarts and re-provisions.
  ({ dbStore, tools, repository, builtinModules } = freshRequire());
  const outcome = builtinModules.provisionBuiltinModules();
  assert.deepStrictEqual(outcome.errors, [], `recovery provisioning must not error: ${JSON.stringify(outcome.errors)}`);

  const after = repository.getModule('data-utilities');
  assert.strictEqual(after.state, 'enabled', 'module should recover to enabled');
  assert.strictEqual(after.entry_hash, trueHash, 'entry hash should be re-bound to the current on-disk entry');
  assert.strictEqual(after.error, null, 'error should be cleared');
  for (const name of DATA_UTILITY_TOOLS) {
    assert.ok(tools.getBuiltinRegistry().get(name), `${name} should be active again after recovery`);
  }
  const recovery = transitionEvents().filter(e => e.from === 'error' && e.to === 'installed');
  assert.ok(recovery.length >= 1, 'an error -> installed recovery transition should be recorded');
});

// MER.2 — the re-bind refuses a non-builtin module (fail-closed for third party).
test('MER.2 rebindBuiltinEntry refuses a non-builtin module', () => {
  // Flip the source to a third-party value; the integrity control must not be
  // relaxed for modules whose code is not the trusted shipped source.
  dbStore.getDb().prepare("UPDATE platform_modules SET source = 'discovered' WHERE name = 'data-utilities'").run();
  assert.throws(
    () => repository.rebindBuiltinEntry('data-utilities', { entryPoint: 'src/modules/entries/data-utilities.js', entryHash: trueHash }),
    /non-builtin/,
    'rebind must refuse a non-builtin module'
  );
  // restore for any later logic
  dbStore.getDb().prepare("UPDATE platform_modules SET source = 'builtin' WHERE name = 'data-utilities'").run();
});

// MER.3 — an invalid hash is rejected.
test('MER.3 rebindBuiltinEntry rejects a non-SHA-256 hash', () => {
  assert.throws(
    () => repository.rebindBuiltinEntry('data-utilities', { entryPoint: 'src/modules/entries/data-utilities.js', entryHash: 'not-a-hash' }),
    /SHA-256/,
    'rebind must reject a malformed hash'
  );
});

// MER.4 — the committed expected hashes must match the shipped entry files, so
// a future entry change that forgets to update the constant fails CI loudly
// instead of silently disabling the module on deploy (the #217 failure mode).
test('MER.4 committed expected hashes stay in lockstep with shipped entry files', () => {
  const crypto = require('crypto');
  const entries = Object.entries(builtinModules.EXPECTED_ENTRY_HASHES);
  assert.ok(entries.length >= 1, 'at least one builtin expected hash should be pinned');
  for (const [name, expected] of entries) {
    const file = path.join(__dirname, '..', builtinModules.entryPointFor(name));
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.strictEqual(expected, actual, `EXPECTED_ENTRY_HASHES["${name}"] is stale; update it in the same commit as the entry change`);
  }
});

// MER.5 — an on-disk entry whose hash matches neither the stored binding nor the
// committed expected hash is treated as tampering and left fail-closed.
test('MER.5 an entry not matching the committed hash is not auto-rebound', () => {
  const fakeEntry = path.join(TEST_DATA_DIR, 'tampered-entry.js');
  fs.writeFileSync(fakeEntry, '// tampered content not shipped with the build\nmodule.exports = {};\n');
  const rel = path.relative(process.cwd(), fakeEntry);
  dbStore.getDb()
    .prepare("UPDATE platform_modules SET entry_point = ?, entry_hash = ?, state = 'error', error = 'stale' WHERE name = 'data-utilities'")
    .run(rel, WRONG_HASH);

  ({ dbStore, tools, repository, builtinModules } = freshRequire());
  builtinModules.provisionBuiltinModules();

  const after = repository.getModule('data-utilities');
  assert.strictEqual(after.state, 'error', 'a tampered/mismatched entry must stay fail-closed, not be re-bound');
  assert.strictEqual(after.entry_hash, WRONG_HASH, 'the stored binding must not be overwritten for a non-attested entry');
});

if (failures) { console.error(`\n${failures} entry-rebind test(s) failed.`); process.exit(1); }
console.log('\nBuiltin module entry-rebind tests passed.');
