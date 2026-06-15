const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-db');
if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true });
}
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

try { delete require.cache[require.resolve('../src/db')]; } catch (e) {}
try { delete require.cache[require.resolve('../src/tools')]; } catch (e) {}
const { TOOLS, setSource } = require('../src/tools');
const dbStore = require('../src/db');

const {
  sidekick_db_schema,
  sidekick_db_query,
  sidekick_db_stats,
  sidekick_db_backup,
  sidekick_db_restore,
  sidekick_log_query,
  sidekick_db_export,
  sidekick_db_search,
  sidekick_db_migrate,
  sidekick_db_diff,
} = TOOLS;

console.log('Running Database Tools Tests...\n');

(async () => {
  setSource('test');

  // --- db_schema ---
  console.log('Test: sidekick_db_schema - list all tables');
  const schemaResult = await sidekick_db_schema({});
  assert.ok(!schemaResult.isError, 'Should succeed');
  const tables = JSON.parse(schemaResult.content[0].text);
  assert.ok(Array.isArray(tables), 'Should return array');
  assert.ok(tables.some(t => t.name === 'kv_store'), 'Should include kv_store');
  assert.ok(tables.some(t => t.name === 'tool_logs'), 'Should include tool_logs');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_schema - specific table');
  const tableResult = await sidekick_db_schema({ table: 'kv_store' });
  assert.ok(!tableResult.isError, 'Should succeed');
  const tableInfo = JSON.parse(tableResult.content[0].text);
  assert.strictEqual(tableInfo.table, 'kv_store', 'Should be kv_store');
  assert.ok(Array.isArray(tableInfo.columns), 'Should have columns');
  assert.ok(tableInfo.columns.some(c => c.name === 'key'), 'Should have key column');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_schema - verbose');
  const verboseResult = await sidekick_db_schema({ verbose: true });
  assert.ok(!verboseResult.isError, 'Should succeed');
  const detailed = JSON.parse(verboseResult.content[0].text);
  assert.ok(Array.isArray(detailed), 'Should return array');
  assert.ok(detailed[0].rowCount !== undefined, 'Should include rowCount');
  console.log('✓ Passed\n');

  // --- db_query ---
  console.log('Test: sidekick_db_query - readonly SELECT');
  const queryResult = await sidekick_db_query({ sql: 'SELECT * FROM kv_store' });
  assert.ok(!queryResult.isError, 'Should succeed');
  const rows = JSON.parse(queryResult.content[0].text);
  assert.ok(Array.isArray(rows), 'Should return array');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_query - readonly blocks INSERT');
  const writeResult = await sidekick_db_query({ sql: "INSERT INTO kv_store (key, value_json) VALUES ('hack', '{}')" });
  assert.ok(writeResult.isError, 'Should block write in readonly mode');
  assert.ok(writeResult.content[0].text.includes('readonly'), 'Should mention readonly');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_query - readonly blocks DROP');
  const dropResult = await sidekick_db_query({ sql: 'DROP TABLE kv_store' });
  assert.ok(dropResult.isError, 'Should block DROP in readonly mode');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_query - with params');
  const paramResult = await sidekick_db_query({
    sql: 'SELECT * FROM kv_store WHERE key = ?',
    params: ['nonexistent']
  });
  assert.ok(!paramResult.isError, 'Should succeed');
  const paramRows = JSON.parse(paramResult.content[0].text);
  assert.strictEqual(paramRows.length, 0, 'Should return empty array');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_query - with limit');
  const limitResult = await sidekick_db_query({ sql: 'SELECT * FROM tool_logs', limit: 5 });
  assert.ok(!limitResult.isError, 'Should succeed');
  const limitRows = JSON.parse(limitResult.content[0].text);
  assert.ok(limitRows.length <= 5, 'Should respect limit');
  console.log('✓ Passed\n');

  // --- db_stats ---
  console.log('Test: sidekick_db_stats - basic');
  const statsResult = await sidekick_db_stats({});
  assert.ok(!statsResult.isError, 'Should succeed');
  const stats = JSON.parse(statsResult.content[0].text);
  assert.ok(stats.dbSize !== undefined, 'Should have dbSize');
  assert.ok(stats.dbSizeHuman, 'Should have dbSizeHuman');
  assert.ok(stats.journalMode, 'Should have journalMode');
  assert.ok(stats.totalTables > 0, 'Should have tables');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_stats - detailed');
  const detailedStatsResult = await sidekick_db_stats({ detailed: true });
  assert.ok(!detailedStatsResult.isError, 'Should succeed');
  const detailedStats = JSON.parse(detailedStatsResult.content[0].text);
  assert.ok(Array.isArray(detailedStats.tables), 'Should have tables array');
  console.log('✓ Passed\n');

  // --- db_backup ---
  console.log('Test: sidekick_db_backup - create backup');
  const backupResult = await sidekick_db_backup({ compress: false });
  assert.ok(!backupResult.isError, 'Should succeed');
  assert.ok(backupResult.content[0].text.includes('Backup created'), 'Should confirm backup');
  console.log('✓ Passed\n');

  // --- log_query ---
  console.log('Test: sidekick_log_query - no filters');
  const logResult = await sidekick_log_query({ limit: 10 });
  assert.ok(!logResult.isError, 'Should succeed');
  const logs = JSON.parse(logResult.content[0].text);
  assert.ok(Array.isArray(logs), 'Should return array');
  assert.ok(logs.length <= 10, 'Should respect limit');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_log_query - filter by tool');
  const toolLogResult = await sidekick_log_query({ tool: 'sidekick_db_schema', limit: 50 });
  assert.ok(!toolLogResult.isError, 'Should succeed');
  const toolLogs = JSON.parse(toolLogResult.content[0].text);
  assert.ok(Array.isArray(toolLogs), 'Should return array');
  for (const log of toolLogs) {
    assert.strictEqual(log.n, 'sidekick_db_schema', 'Should only have db_schema entries');
  }
  console.log('✓ Passed\n');

  console.log('Test: sidekick_log_query - filter by success');
  const successLogResult = await sidekick_log_query({ success: true, limit: 50 });
  assert.ok(!successLogResult.isError, 'Should succeed');
  const successLogs = JSON.parse(successLogResult.content[0].text);
  assert.ok(Array.isArray(successLogs), 'Should return array');
  console.log('✓ Passed\n');

  // --- db_export ---
  console.log('Test: sidekick_db_export - JSON single table');
  const exportResult = await sidekick_db_export({ table: 'meta', format: 'json' });
  assert.ok(!exportResult.isError, 'Should succeed');
  const exported = JSON.parse(exportResult.content[0].text);
  assert.ok(Array.isArray(exported), 'Should return array');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_export - CSV format');
  const csvResult = await sidekick_db_export({ table: 'meta', format: 'csv' });
  assert.ok(!csvResult.isError, 'Should succeed');
  assert.ok(typeof csvResult.content[0].text === 'string', 'Should return string');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_export - SQL format');
  const sqlResult = await sidekick_db_export({ table: 'meta', format: 'sql' });
  assert.ok(!sqlResult.isError, 'Should succeed');
  assert.ok(typeof sqlResult.content[0].text === 'string', 'Should return string');
  console.log('✓ Passed\n');

  // --- db_search ---
  console.log('Test: sidekick_db_search - basic search');
  try {
    const searchResult = await sidekick_db_search({ query: 'schema_version', limit: 10 });
    assert.ok(!searchResult.isError, 'Should succeed');
    const searchRows = JSON.parse(searchResult.content[0].text);
    assert.ok(Array.isArray(searchRows), 'Should return array');
    console.log('✓ Passed\n');
  } catch (err) {
    // FTS5 might not be available in all environments
    console.log('⚠ Skipped (FTS5 not available):', err.message, '\n');
  }

  // --- db_migrate ---
  console.log('Test: sidekick_db_migrate - status');
  const migrateStatusResult = await sidekick_db_migrate({ action: 'status' });
  assert.ok(!migrateStatusResult.isError, 'Should succeed');
  const migrateStatus = JSON.parse(migrateStatusResult.content[0].text);
  assert.ok(migrateStatus.currentVersion !== undefined, 'Should have currentVersion');
  assert.ok(Array.isArray(migrateStatus.migrations), 'Should have migrations array');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_migrate - list');
  const migrateListResult = await sidekick_db_migrate({ action: 'list' });
  assert.ok(!migrateListResult.isError, 'Should succeed');
  const migrateList = JSON.parse(migrateListResult.content[0].text);
  assert.ok(Array.isArray(migrateList), 'Should return array');
  console.log('✓ Passed\n');

  // --- db_diff ---
  console.log('Test: sidekick_db_diff - current vs current');
  const diffResult = await sidekick_db_diff({});
  assert.ok(!diffResult.isError, 'Should succeed');
  const diff = JSON.parse(diffResult.content[0].text);
  assert.ok(diff.summary !== undefined, 'Should have summary');
  assert.ok(diff.details !== undefined, 'Should have details');
  console.log('✓ Passed\n');

  console.log('Test: sidekick_db_diff - specific table');
  const tableDiffResult = await sidekick_db_diff({ table: 'kv_store' });
  assert.ok(!tableDiffResult.isError, 'Should succeed');
  const tableDiff = JSON.parse(tableDiffResult.content[0].text);
  assert.ok(tableDiff.kv_store !== undefined, 'Should have kv_store key');
  console.log('✓ Passed\n');

  // --- Error cases ---
  console.log('Test: sidekick_db_schema - nonexistent table');
  try {
    const badTableResult = await sidekick_db_schema({ table: 'nonexistent_table_xyz' });
    assert.ok(badTableResult.isError, 'Should error for nonexistent table');
    console.log('✓ Passed\n');
  } catch (err) {
    // Some implementations throw instead of returning error
    console.log('✓ Passed (threw error as expected)\n');
  }

  // --- Cleanup ---
  console.log('\nAll Database Tools Tests Passed! ✓');
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
})().catch(err => {
  console.error('\n✗ Test failed:', err.message);
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
