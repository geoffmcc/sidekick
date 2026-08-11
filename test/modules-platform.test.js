const assert = require('assert');

const {
  runModuleMigrations,
  assertMigrationIsDataOnly,
} = require('../src/modules/migrations');
const { createModuleServices, NARROW_SERVICE_KEYS } = require('../src/modules/services');

console.log('Running Module Platform Primitive Tests...');

class RecordingDb {
  constructor(failOn) {
    this.statements = [];
    this.failOn = failOn;
  }

  exec(sql) {
    this.statements.push(sql);
    if (sql === this.failOn) throw new Error('synthetic migration failure');
  }
}

let failed = 0;
function check(condition, message) {
  if (!condition) {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

try {
  const db = new RecordingDb();
  const result = runModuleMigrations(db, 'example', [
    { name: '001-seed', sql: 'INSERT INTO platform_modules (module_id, name, version, state, registered_at) VALUES (\'id\', \'example\', \'1.0.0\', \'installed\', \'now\')' },
    { name: '002-update', sql: 'UPDATE platform_modules SET state = \'configured\' WHERE name = \'example\'' },
  ]);
  check(result.applied.join(',') === '001-seed,002-update', 'migrations run in declaration order');
  check(result.alreadyApplied.join(',') === '001-seed,002-update', 'migration progress includes newly applied names');
  check(db.statements[0] === 'BEGIN IMMEDIATE', 'migration batch starts one transaction');
  check(db.statements[db.statements.length - 1] === 'COMMIT', 'migration batch commits once');

  const skipped = runModuleMigrations(new RecordingDb(), 'example', [
    { name: '001-seed', sql: 'UPDATE platform_modules SET state = \'bad\'' },
  ], ['001-seed']);
  check(skipped.applied.length === 0, 'already-applied migration is skipped');
  check(skipped.alreadyApplied[0] === '001-seed', 'skipped progress is preserved');

  assertMigrationIsDataOnly('WITH rows AS (SELECT 1) SELECT * FROM rows');
  for (const sql of ['CREATE TABLE nope (id INTEGER)', 'ALTER TABLE platform_modules ADD COLUMN nope TEXT', 'PRAGMA user_version = 1']) {
    checkThrows(() => assertMigrationIsDataOnly(sql), `forbidden migration rejected: ${sql.split(' ')[0]}`);
  }

  const failedDb = new RecordingDb('UPDATE platform_modules SET state = \'broken\'');
  assert.throws(() => runModuleMigrations(failedDb, 'example', [
    { name: '001-seed', sql: 'INSERT INTO platform_modules (module_id, name, version, state, registered_at) VALUES (\'id\', \'example\', \'1.0.0\', \'installed\', \'now\')' },
    { name: '002-fail', sql: 'UPDATE platform_modules SET state = \'broken\'' },
  ]), /migration batch failed/);
  check(failedDb.statements[failedDb.statements.length - 1] === 'ROLLBACK', 'failed batch rolls back');

  const services = createModuleServices('example', { enabled: true });
  check(Object.keys(services).join(',') === 'moduleName,v1', 'service facade exposes only versioned surface');
  check(Object.keys(services.v1).sort().join(',') === NARROW_SERVICE_KEYS.slice().sort().join(','), 'v1 facade keys are narrow and stable');
  check(Object.isFrozen(services) && Object.isFrozen(services.v1) && Object.isFrozen(services.v1.config), 'service facade and config are frozen');
} catch (error) {
  failed++;
  console.error('  UNEXPECTED ERROR:', error.message);
  console.error(error.stack);
}

function checkThrows(fn, message) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${message} (expected throw, did not throw)`);
  } catch {
    // expected
  }
}

console.log(failed === 0 ? 'Module Platform Primitive Tests passed' : `Module Platform Primitive Tests FAILED (${failed} failure(s))`);
process.exit(failed === 0 ? 0 : 1);
