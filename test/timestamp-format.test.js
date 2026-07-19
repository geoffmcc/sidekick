/**
 * Timestamp format consistency test.
 *
 * Timestamp columns store ISO 8601 ("2026-07-19T21:34:49.497Z"). SQLite's
 * datetime() returns a space-separated string ("2026-07-19 21:34:49"). Because
 * 'T' (0x54) sorts above ' ' (0x20), comparing an ISO column against a
 * datetime('now', ...) bound silently matches every row once the date parts are
 * equal — and an invalid modifier makes datetime() return NULL, matching none.
 *
 * Both failure modes are silent: one looks like "nothing happened recently", the
 * other like "everything is recent". These tests pin the ISO contract.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-timestamp-format');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/db')];
const dbStore = require('../src/db');

// Build the authentic schema so these assertions run against the real tables
// rather than a hand-rolled approximation.
dbStore.runPendingMigrations();

const ROOT = path.join(__dirname, '..');
const SRC_FILES = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) SRC_FILES.push(full);
  }
})(path.join(ROOT, 'src'));

console.log('Running Timestamp Format Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

console.log('TS.1: the two silent failure modes are real');
test('an invalid SQLite modifier yields NULL, matching nothing', () => {
  const db = dbStore.getDb();
  const bad = db.prepare("SELECT datetime('now','-24h') AS v").get().v;
  assert.strictEqual(bad, null, "'-24h' is not a valid modifier and returns NULL");
  const good = db.prepare("SELECT datetime('now','-24 hours') AS v").get().v;
  assert.ok(good, "'-24 hours' is valid");
  // A NULL bound makes every comparison NULL, so nothing matches.
  const matched = db.prepare("SELECT COUNT(*) AS c FROM tool_logs WHERE timestamp > datetime('now','-24h')").get().c;
  assert.strictEqual(matched, 0, 'a NULL bound silently matches zero rows');
});

test('an ISO value sorts above a same-date space-separated bound', () => {
  const db = dbStore.getDb();
  // The mis-ordering bites when the date parts are equal: 'T' (0x54) then
  // decides against ' ' (0x20), so an earlier ISO time outranks a later bound.
  const cmp = db.prepare(
    "SELECT ('2026-07-19T00:00:01.000Z' > '2026-07-19 20:00:00') AS iso_wins"
  ).get().iso_wins;
  assert.strictEqual(cmp, 1, 'a 00:00:01 ISO value wrongly sorts above a 20:00 bound on the same date');

  // Same flaw against a real column: a row from the start of the bound's own day
  // is hours older than a 1-hour window, yet matches it.
  const bound = db.prepare("SELECT datetime('now','-1 hour') AS v").get().v;
  const boundDate = bound.slice(0, 10);
  dbStore.appendToolLog({ t: `${boundDate}T00:00:01.000Z`, n: 'early_same_day', ok: true, src: 'mcp', s: 'x' });

  const naive = db.prepare(
    "SELECT COUNT(*) AS c FROM tool_logs WHERE tool_name = 'early_same_day' AND timestamp > datetime('now','-1 hour')"
  ).get().c;
  assert.strictEqual(naive, 1, 'the start-of-day row wrongly matches a 1-hour window');

  const isoBound = new Date(Date.now() - 3600 * 1000).toISOString();
  const correct = db.prepare(
    "SELECT COUNT(*) AS c FROM tool_logs WHERE tool_name = 'early_same_day' AND timestamp > ?"
  ).get(isoBound).c;
  assert.strictEqual(correct, 0, 'an ISO bound correctly excludes it');
});

console.log('TS.2: no source compares a timestamp column against datetime()');
test('runtime queries bind ISO values instead of using datetime()', () => {
  const offenders = [];
  for (const file of SRC_FILES) {
    const source = fs.readFileSync(file, 'utf-8');
    for (const line of source.split('\n')) {
      if (!line.includes("datetime('now'")) continue;
      if (/DEFAULT \(datetime\('now'\)\)/.test(line)) continue;   // column defaults
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;              // comments
      offenders.push(`${path.relative(ROOT, file)}: ${line.trim().slice(0, 110)}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these lines must bind an ISO value rather than use datetime():\n  ' + offenders.join('\n  '));
});

console.log('TS.3: writers store ISO');
test('tool logs and platform events are written as ISO', () => {
  const db = dbStore.getDb();
  dbStore.appendToolLog({ t: new Date().toISOString(), n: 'iso_probe', ok: true, src: 'mcp', s: 'x' });
  const rows = db.prepare('SELECT timestamp FROM tool_logs').all();
  assert.ok(rows.length > 0, 'rows written');
  for (const r of rows) {
    assert.ok(ISO_RE.test(r.timestamp), `non-ISO timestamp stored: ${r.timestamp}`);
  }
});

console.log('TS.4: the platform kernel counts real recent events');
test('generatePlatformDocs reports recent events instead of always zero', () => {
  const kernel = require('../src/platform/kernel');
  const db = dbStore.getDb();
  const docs = kernel.generatePlatformDocs();
  assert.ok(docs && Array.isArray(docs.recent_events_24h), 'recent_events_24h is present');

  // Seed one event inside the window and one well outside it.
  const cols = db.prepare('PRAGMA table_info(platform_execution_events)').all().map(c => c.name);
  if (!cols.includes('event_type') || !cols.includes('timestamp')) {
    console.log('    (platform_execution_events unavailable in this schema; static guard still applies)');
    return;
  }
  const insert = db.prepare(
    'INSERT INTO platform_execution_events (event_id, event_type, timestamp, source) VALUES (?, ?, ?, ?)'
  );
  const recentTs = new Date(Date.now() - 60 * 1000).toISOString();
  const oldTs = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  insert.run('evt_recent_probe', 'probe_recent', recentTs, 'test');
  insert.run('evt_old_probe', 'probe_old', oldTs, 'test');

  const after = kernel.generatePlatformDocs();
  const types = after.recent_events_24h.map(e => e.event_type);
  assert.ok(types.includes('probe_recent'), 'an event from a minute ago is counted as recent');
  assert.ok(!types.includes('probe_old'), 'a 72-hour-old event is excluded');
});

console.log('TS.5: memory stats respect real expiry');
test('an expired memory is counted, a future expiry is not', () => {
  const db = dbStore.getDb();
  const cols = db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
  if (!cols.includes('expires_at')) {
    console.log('    (memories table unavailable in this schema; static guard still applies)');
    return;
  }
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO memories (id, type, content, project, confidence, enabled, state, expires_at, created_at, updated_at) " +
    "VALUES (?, 'note', 'x', 'p', 0.5, 1, 'active', ?, ?, ?)"
  );
  const now = new Date().toISOString();
  stmt.run('mem-expired', new Date(Date.now() - 3600 * 1000).toISOString(), now, now);
  stmt.run('mem-future', new Date(Date.now() + 86400 * 1000).toISOString(), now, now);

  const stats = dbStore.getMemoryIntelligenceStats();
  assert.strictEqual(stats.expired, 1, `exactly the past-expiry memory is expired, got ${stats.expired}`);
});

console.log('\nTimestamp Format tests: ' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
