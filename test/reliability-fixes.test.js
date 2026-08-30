const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const testData = path.join(__dirname, 'test-data-reliability-fixes');
fs.rmSync(testData, { recursive: true, force: true });
fs.mkdirSync(testData, { recursive: true });

console.log('Running reliability regression tests...\n');

const invalidSelection = spawnSync(process.execPath, [path.join(root, 'test/run-all.js'), 'does-not-exist.test.js'], {
  cwd: root,
  encoding: 'utf8',
});
assert.notStrictEqual(invalidSelection.status, 0, 'an invalid requested suite must fail nonzero');
assert.match(invalidSelection.stderr, /Invalid test suite selection/);
console.log('  passed: invalid suite selection fails nonzero');

const dbPath = path.join(testData, 'nested', 'custom.sqlite');
const migrationsDir = path.join(testData, 'migrations');
fs.mkdirSync(migrationsDir, { recursive: true });
fs.writeFileSync(path.join(migrationsDir, '001_initial.sql'), '');
fs.writeFileSync(path.join(migrationsDir, '002_race.sql'), 'CREATE TABLE migration_race (id INTEGER PRIMARY KEY);');

const childScript = `
  const store = require(${JSON.stringify(path.join(root, 'src/db.js'))});
  setTimeout(() => {
    store.runPendingMigrations();
    store.closeDatabase();
  }, 250);
`;
const childEnv = {
  ...process.env,
  NODE_ENV: 'test',
  SIDEKICK_DATA_DIR: path.join(testData, 'data'),
  SIDEKICK_DB_FILE: dbPath,
  SIDEKICK_MIGRATIONS_DIR: migrationsDir,
};

function runMigrationChild() {
  const child = spawn(process.execPath, ['-e', childScript], {
    cwd: root,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on('close', (status) => resolve({ status, stderr })));
  return { done };
}

(async () => {
  // Stagger process startup so SQLite's initialization PRAGMAs do not race;
  // the delayed migration calls still overlap at the lock boundary.
  const childProcesses = [runMigrationChild()];
  await new Promise((resolve) => setTimeout(resolve, 100));
  childProcesses.push(runMigrationChild());
  const children = await Promise.all(childProcesses.map((child) => child.done));
  assert.ok(fs.existsSync(dbPath), 'custom database parent directory should be created');
  assert.deepStrictEqual(children.map((child) => child.status), [0, 0], `concurrent migration processes failed: ${JSON.stringify(children)}`);

  const db = new Database(dbPath, { readonly: true });
  try {
    assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_race'").get());
  } finally {
    db.close();
    fs.rmSync(testData, { recursive: true, force: true });
  }
  console.log('  passed: custom DB parent creation and concurrent migration locking');
  console.log('\nReliability regression tests passed.');
})().catch((error) => {
  console.error(error);
  fs.rmSync(testData, { recursive: true, force: true });
  process.exit(1);
});
