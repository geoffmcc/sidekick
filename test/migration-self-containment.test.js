// Migration self-containment and cross-process schema safety (C1 + C2).
//
// C1: the migration set must build a complete schema on its own, with no
//     dependency on the runtime bootstrap in src/db.js. Before the fix, a
//     migrations-only build failed at 007 ("no such column: session_id")
//     because tool_logs telemetry columns were only added by the runtime.
// C2: applying migrations after the runtime has already created a table (the
//     cross-process dashboard-first boot order) must not throw
//     "duplicate column name" on bare ALTER TABLE ADD COLUMN.
//
// Both are fixed by idempotent ALTER TABLE ADD COLUMN in the migration runner
// (src/db.js execMigrationSql, built on src/core/sql-statements). This test
// exercises that exact splitter + parser logic against the real migration
// files on a bare database, and also verifies the real runner on the runtime
// boot path.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { splitSqlStatements, parseAddColumn } = require('../src/core/sql-statements');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
}

// Mirror of src/db.js execMigrationSql, kept in lockstep with the real runner:
// idempotent ALTER TABLE ADD COLUMN via the same shared core functions.
function applyMigration(db, sql) {
  for (const statement of splitSqlStatements(sql)) {
    const add = parseAddColumn(statement);
    if (add) {
      const target = add.column.toLowerCase();
      const exists = db.prepare(`PRAGMA table_info("${add.table}")`).all().some(c => c.name.toLowerCase() === target);
      if (exists) continue;
    }
    db.exec(statement);
  }
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
}

console.log('Running Migration Self-Containment Tests...\n');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// SC.1 — true migrations-only build (C1). Bare DB, no src/db bootstrap.
test('SC.1 migrations-only build is self-contained (C1)', () => {
  const db = new Database(':memory:');
  try {
    for (const f of migrationFiles()) {
      applyMigration(db, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }
    const toolLogCols = tableColumns(db, 'tool_logs');
    for (const col of ['session_id', 'task_id', 'arg_fingerprint', 'correlation_id', 'retry', 'generated_procedure']) {
      assert.ok(toolLogCols.includes(col), `tool_logs.${col} must be created by migrations alone`);
    }
    const tableCount = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
    assert.ok(tableCount >= 70, `expected the full schema, got ${tableCount} tables`);
    // Note: schema_version bookkeeping is the runner's responsibility (it UPDATEs
    // meta per file), not migration content, so it is asserted by SC.4 and the
    // kernel-migration-parity suite rather than here.
  } finally { db.close(); }
});

// SC.2 — runtime-first then migrations (C2). Simulate the cross-process order
// where compute tables already carry the columns migrations 014-024 add.
test('SC.2 runtime-created columns do not collide with migration ALTERs (C2)', () => {
  const db = new Database(':memory:');
  try {
    // Build the base schema through migrations 001-013 first.
    for (const f of migrationFiles()) {
      applyMigration(db, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      if (f.startsWith('013_')) break;
    }
    // Simulate the runtime having already added the later columns.
    db.exec('ALTER TABLE compute_workers ADD COLUMN credential_hash TEXT');
    db.exec('ALTER TABLE compute_workers ADD COLUMN model_inventory_json TEXT NOT NULL DEFAULT \'[]\'');
    db.exec('ALTER TABLE compute_jobs ADD COLUMN idempotency_key TEXT');
    // Now the remaining migrations (014+) must apply without duplicate-column errors.
    let threw = null;
    for (const f of migrationFiles()) {
      if (f <= '013_compute.sql') continue;
      try { applyMigration(db, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')); }
      catch (e) { threw = `${f}: ${e.message}`; break; }
    }
    assert.strictEqual(threw, null, `migrations after runtime schema must not throw, got ${threw}`);
    assert.ok(tableColumns(db, 'compute_workers').includes('credential_hash'));
    assert.ok(tableColumns(db, 'compute_workers').includes('protocol_version'), 'later columns still applied');
  } finally { db.close(); }
});

// SC.3 — statement splitter fidelity: whole-file exec and per-statement exec of
// a representative migration produce an identical schema.
test('SC.3 splitter preserves statements verbatim', () => {
  const prereq = [];
  for (const f of migrationFiles()) { prereq.push(f); if (f.startsWith('011_')) break; }
  function buildThrough(applyFn) {
    const db = new Database(':memory:');
    for (const f of prereq) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      applyFn(db, sql);
    }
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
      .all().map(r => `${r.type}|${r.name}|${(r.sql || '').replace(/\s+/g, ' ').trim()}`).join('\n');
    db.close();
    return schema;
  }
  const wholeFile = buildThrough((db, sql) => db.exec(sql));
  const perStatement = buildThrough((db, sql) => { for (const s of splitSqlStatements(sql)) db.exec(s); });
  assert.strictEqual(perStatement, wholeFile, 'per-statement execution must match whole-file execution');
});

// SC.4 — real runner on the runtime boot path: the edited 007 must apply
// cleanly when the bootstrap already created the tool_logs columns.
test('SC.4 real runner applies edited 007 idempotently on runtime boot', () => {
  const dataDir = path.join(__dirname, 'test-data-migration-self-containment');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const prev = { dir: process.env.SIDEKICK_DATA_DIR, file: process.env.SIDEKICK_DB_FILE };
  process.env.SIDEKICK_DATA_DIR = dataDir;
  process.env.SIDEKICK_DB_FILE = path.join(dataDir, 'runtime.sqlite');
  try {
    delete require.cache[require.resolve('../src/db')];
    const store = require('../src/db');
    // db.js bootstrap already created tool_logs with telemetry columns.
    const result = store.runPendingMigrations();
    assert.ok(result.applied >= 34, `expected migrations to apply, got ${result.applied}`);
    const cols = store.getDb().prepare('PRAGMA table_info(tool_logs)').all().map(c => c.name);
    assert.ok(cols.includes('session_id') && cols.includes('arg_fingerprint'), 'telemetry columns present after real runner');
  } finally {
    try { require('../src/db').closeDatabase?.(); } catch {}
    delete require.cache[require.resolve('../src/db')];
    if (prev.dir === undefined) delete process.env.SIDEKICK_DATA_DIR; else process.env.SIDEKICK_DATA_DIR = prev.dir;
    if (prev.file === undefined) delete process.env.SIDEKICK_DB_FILE; else process.env.SIDEKICK_DB_FILE = prev.file;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// SC.5 — case-insensitive idempotent skip: a differently-cased ADD COLUMN for an
// existing column must be skipped, not throw "duplicate column name".
test('SC.5 idempotent skip is case-insensitive', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE t (id TEXT)');
    db.exec('ALTER TABLE t ADD COLUMN retry INTEGER NOT NULL DEFAULT 0');
    // Emulate the runner's idempotent handling with a mixed-case column name.
    applyMigration(db, 'ALTER TABLE t ADD COLUMN Retry INTEGER NOT NULL DEFAULT 0;');
    const cols = tableColumns(db, 't');
    assert.strictEqual(cols.filter(c => c.toLowerCase() === 'retry').length, 1, 'no duplicate column added');
  } finally { db.close(); }
});

// SC.6 — the migration runner rejects traversal / non-filename names, so a
// caller-supplied name cannot execute SQL from outside the migrations dir.
test('SC.6 runMigration rejects traversal and non-filename names', () => {
  const dataDir = path.join(__dirname, 'test-data-migration-name-guard');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const prev = { dir: process.env.SIDEKICK_DATA_DIR, file: process.env.SIDEKICK_DB_FILE };
  process.env.SIDEKICK_DATA_DIR = dataDir;
  process.env.SIDEKICK_DB_FILE = path.join(dataDir, 'guard.sqlite');
  try {
    delete require.cache[require.resolve('../src/db')];
    const store = require('../src/db');
    for (const bad of ['123_../../etc/x.sql', '999_evil', '/abs/path.sql', '007_evolve_dynamic_tools']) {
      assert.throws(() => store.runMigration(bad, 'CREATE TABLE should_not_exist (x TEXT);', ''),
        /NNN_name\.sql/, `should reject ${bad}`);
    }
    const leaked = store.getDb().prepare("SELECT name FROM sqlite_master WHERE name='should_not_exist'").get();
    assert.ok(!leaked, 'rejected migration must not execute any SQL');
  } finally {
    try { require('../src/db').closeDatabase?.(); } catch {}
    delete require.cache[require.resolve('../src/db')];
    if (prev.dir === undefined) delete process.env.SIDEKICK_DATA_DIR; else process.env.SIDEKICK_DATA_DIR = prev.dir;
    if (prev.file === undefined) delete process.env.SIDEKICK_DB_FILE; else process.env.SIDEKICK_DB_FILE = prev.file;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

if (failures) { console.error(`\n${failures} migration self-containment test(s) failed.`); process.exit(1); }
console.log('\nMigration self-containment tests passed.');
