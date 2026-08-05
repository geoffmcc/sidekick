const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-memory-core-test-'));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_AUTO_MEMORY = '0';
process.env.SIDEKICK_EMBEDDINGS = '0';
process.env.SIDEKICK_APPROVAL_MODE = 'off';

const db = require('../src/db');
const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const family = require('../src/tools/families/memory-core');
db.runPendingMigrations();

const text = result => result.content[0].text;

console.log('Running Memory Core Family Tests...');

(async () => {
  try {
    const descriptor = tools.getBuiltinRegistry().get('memory');
    assert.strictEqual(descriptor.family, 'memory-core');
    assert.strictEqual(descriptor.category, 'Context & Learning');
    assert.strictEqual(descriptor.risk, 'medium');
    assert.strictEqual(descriptor.source, 'builtin');
    assert.strictEqual(typeof descriptor.handler, 'function');
    assert.strictEqual(legacy.TOOLS.memory, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, 'memory'));
    assert.strictEqual(family.descriptors.length, 1);

    let result = await family.sidekick_memory({ action: 'remember', project: 'sidekick', type: 'fact', content: 'Dashboard runs on port 4098', evidence: 'test evidence', tags: 'runtime,verified' });
    const remembered = JSON.parse(text(result));
    assert.ok(remembered.memory.id);
    assert.ok(!JSON.stringify(remembered).includes('secret-value'));
    assert.deepStrictEqual(remembered.memory.tags, ['runtime', 'verified']);

    result = await tools.dispatchTool({ name: 'sidekick_memory', args: { action: 'list', project: 'sidekick' }, context: { source: 'mcp' } });
    const query = JSON.parse(text(result));
    assert.strictEqual(query.count, 1);
    assert.strictEqual(query.fresh_eyes, false);

    result = await family.sidekick_memory({ action: 'remember', project: 'sidekick', type: 'fact', content: 'Dashboard password=secret-value' });
    const redacted = JSON.parse(text(result));
    assert.ok(!JSON.stringify(redacted).includes('secret-value'));

    result = await family.sidekick_memory({ action: 'query', query: 'Dashboard', project: 'sidekick', fresh_eyes: true });
    assert.deepStrictEqual(JSON.parse(text(result)).memories, []);

    result = await family.sidekick_memory({ action: 'get', id: remembered.memory.id });
    assert.strictEqual(JSON.parse(text(result)).memory.id, remembered.memory.id);
    result = await family.sidekick_memory({ action: 'explain', id: remembered.memory.id });
    assert.ok(JSON.parse(text(result)).evidence.length >= 1);

    result = await family.sidekick_memory({ action: 'pin', id: remembered.memory.id, reason: 'test' });
    assert.strictEqual(text(result), `Memory ${remembered.memory.id} pinned`);
    assert.strictEqual(db.getMemoryById(remembered.memory.id, { includeDisabled: true }).pinned, true);

    result = await family.sidekick_memory({ action: 'health' });
    assert.ok(JSON.parse(text(result)).stats.durable_active >= 1);
    result = await family.sidekick_memory({ action: 'conflicts', project: 'sidekick' });
    assert.deepStrictEqual(JSON.parse(text(result)).memories, []);

    result = await family.sidekick_memory({ action: 'remember' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'content or summary required');
    result = await family.sidekick_memory({ action: 'get', id: 'missing-memory' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'Memory not found: missing-memory');

    console.log('Memory Core Family Tests passed');
  } finally {
    db.closeDatabase?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('Memory Core Family Tests FAILED');
  console.error(error);
  process.exit(1);
});
