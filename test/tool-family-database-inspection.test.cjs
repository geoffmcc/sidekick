const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-db-family');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'database-inspection-test-secret-key';
delete process.env.SIDEKICK_ALLOWED_PATHS;
delete process.env.SIDEKICK_DENIED_PATHS;

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];

const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const family = require('../src/tools/families/database-inspection');
const { dispatchTool } = tools;

console.log('Running Database Inspection Family Tests...');

const text = result => result.content[0].text;
const names = ['db_schema', 'db_query', 'db_stats', 'log_query', 'db_search', 'db_diff'];

(async () => {
  try {
    const registry = tools.getBuiltinRegistry();
    for (const name of names) {
      const descriptor = registry.get(name);
      assert.strictEqual(descriptor.family, 'database-inspection', `${name} should be owned by the database inspection family`);
      assert.strictEqual(descriptor.category, 'Database');
      assert.strictEqual(descriptor.source, 'builtin');
      assert.strictEqual(typeof descriptor.handler, 'function');
      assert.strictEqual(legacy.TOOLS[name], undefined, `${name} should not remain in the legacy handler map`);
      assert.ok(!Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, name), `${name} should have one schema owner`);
    }
    assert.strictEqual(family.descriptors.length, names.length);
    assert.strictEqual(registry.listInDefinitionOrder().length, 103);
    assert.deepStrictEqual(registry.listInDefinitionOrder().map(d => d.name), legacy.TOOL_DEFS.map(d => d.name));

    let result = await family.sidekick_db_schema({});
    assert.ok(!result.isError);
    assert.ok(JSON.parse(text(result)).some(table => table.name === 'kv_store'));

    result = await dispatchTool({ name: 'sidekick_db_query', args: { sql: 'SELECT 1 AS value' }, context: { source: 'mcp', requestId: 'db_family_query' } });
    assert.deepStrictEqual(JSON.parse(text(result)), [{ value: 1 }]);

    result = await dispatchTool({ name: 'db_stats', args: {}, context: { source: 'mcp', requestId: 'db_family_stats' } });
    assert.ok(JSON.parse(text(result)).totalTables > 0);

    const batch = await tools.TOOLS.batch({ calls: [
      { tool: 'db_schema', args: { table: 'kv_store' } },
      { tool: 'sidekick_db_query', args: { sql: 'SELECT 2 AS value' } },
    ] });
    const batchResults = JSON.parse(text(batch));
    assert.strictEqual(batchResults[0].error, false);
    assert.strictEqual(batchResults[1].error, false);

    process.env.SIDEKICK_ALLOWED_PATHS = TEST_DATA_DIR;
    result = await family.sidekick_db_diff({ snapshot_a: path.join(path.dirname(TEST_DATA_DIR), 'outside.json') });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('Path blocked by policy'));

    console.log('Database Inspection Family Tests passed');
  } finally {
    delete process.env.SIDEKICK_ALLOWED_PATHS;
    delete process.env.SIDEKICK_DENIED_PATHS;
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('Database Inspection Family Tests FAILED');
  console.error(error);
  process.exit(1);
});
