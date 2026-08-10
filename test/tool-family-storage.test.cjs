const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-storage');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'storage-test-secret-key';
delete process.env.SIDEKICK_BLOCKED_TOOLS;
delete process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS;

delete require.cache[require.resolve('../src/tools')];

const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const family = require('../src/tools/families/storage');
const redis = require('../src/redis');

const text = result => result.content[0].text;

console.log('Running Storage Family Tests...');

(async () => {
  const original = Object.fromEntries(['testConnection', 'get', 'set', 'del', 'keys', 'ttl', 'info', 'flush'].map(name => [name, redis[name]]));
  try {
    const registry = tools.getBuiltinRegistry();
    const expected = {
      store: ['low', 'Storage'],
      get: ['low', 'Storage'],
      delete: ['low', 'Storage'],
      list_projects: ['low', 'Storage'],
      get_by_project: ['low', 'Storage'],
      cache: ['low', 'Efficiency'],
      redis: ['medium', 'Storage'],
    };
    for (const [name, [risk, category]] of Object.entries(expected)) {
      const descriptor = registry.get(name);
      assert.strictEqual(descriptor.family, 'storage');
      assert.strictEqual(descriptor.source, 'builtin');
      assert.strictEqual(descriptor.risk, risk);
      assert.strictEqual(descriptor.category, category);
      assert.deepStrictEqual(descriptor.args, legacy.TOOL_DEFS.find(def => def.name === name).args);
      assert.strictEqual(typeof descriptor.handler, 'function');
      assert.strictEqual(legacy.TOOLS[name], undefined);
    }
    assert.strictEqual(family.descriptors.length, 7);
    assert.strictEqual(family.descriptors.find(d => d.name === 'cache').handler, family.sidekick_cache);
    assert.strictEqual(family.descriptors.find(d => d.name === 'redis').handler, family.sidekick_redis);
    assert.ok(!fs.readFileSync(path.join(__dirname, '../src/tools/families/storage.js'), 'utf8').includes('tools-legacy'));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, 'cache'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, 'redis'), false);
    for (const name of ['store', 'get', 'delete', 'list_projects', 'get_by_project']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, name), false, `${name} should have no duplicate legacy schema`);
    }

    // Redis unavailable: cache falls back and redis reports the original error.
    redis.testConnection = async () => ({ connected: false, error: 'offline' });
    assert.strictEqual(text(await family.sidekick_cache({ action: 'set', key: 'local', value: 'value', ttl: '30s' })), 'Cached local (TTL: 30s)');
    assert.strictEqual(text(await family.sidekick_cache({ action: 'get', key: 'local' })), 'value');
    assert.deepStrictEqual(JSON.parse(text(await family.sidekick_cache({ action: 'list' })))[0].key, 'local');
    const unavailable = await family.sidekick_redis({ action: 'get', key: 'x' });
    assert.strictEqual(unavailable.isError, true);
    assert.strictEqual(text(unavailable), 'Error: Redis not available (offline). Start with: sudo systemctl start sidekick-redis');

    // Redis-first cache behavior and result shapes.
    const values = new Map();
    redis.testConnection = async () => ({ connected: true });
    redis.set = async (key, value, ttl) => { values.set(key, { value, ttl }); return true; };
    redis.get = async key => values.get(key)?.value ?? null;
    redis.keys = async pattern => [...values.keys()].filter(key => pattern === '*' || key.startsWith('cache:'));
    redis.ttl = async key => values.get(key)?.ttl || -1;
    redis.del = async key => values.delete(key) ? 1 : 0;
    assert.strictEqual(text(await family.sidekick_cache({ action: 'set', key: 'remote', value: 'redis-value', ttl: '5m' })), 'Cached remote (TTL: 5m, redis)');
    assert.deepStrictEqual(values.get('cache:remote'), { value: 'redis-value', ttl: 300 });
    assert.strictEqual(text(await family.sidekick_cache({ action: 'get', key: 'remote' })), 'redis-value');
    assert.deepStrictEqual(JSON.parse(text(await family.sidekick_cache({ action: 'list' }))), [{ key: 'remote', expires_in_seconds: 300 }]);
    assert.strictEqual(text(await family.sidekick_cache({ action: 'clear', key: 'remote' })), 'Cleared cache: remote (redis)');

    // Redis actions preserve the legacy validation and response text.
    redis.get = async key => key === 'missing' ? null : 'value';
    redis.info = async () => ({ server: { redis_version: 'test' } });
    redis.flush = async () => 'OK';
    assert.strictEqual(text(await family.sidekick_redis({ action: 'get', key: 'missing' })), '(nil)');
    assert.strictEqual(text(await family.sidekick_redis({ action: 'set', key: 'k', value: 'v', ttl: '12' })), 'OK (TTL: 12s)');
    assert.strictEqual(text(await family.sidekick_redis({ action: 'keys', pattern: 'cache:*' })), '[]');
    assert.strictEqual(text(await family.sidekick_redis({ action: 'ttl', key: 'k' })), '12');
    assert.deepStrictEqual(JSON.parse(text(await family.sidekick_redis({ action: 'info' }))), { server: { redis_version: 'test' } });
    assert.strictEqual(text(await family.sidekick_redis({ action: 'flush' })), 'Redis database flushed');

    redis.get = async key => values.get(key)?.value ?? null;
    let result = await tools.dispatchTool({ name: 'redis', args: { action: 'get', key: 'missing' }, context: { source: 'mcp' } });
    assert.strictEqual(text(result), '(nil)');
    result = await tools.dispatchTool({ name: 'sidekick_cache', args: { action: 'get', key: 'remote' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'Cache miss: remote');

    // KV descriptors execute through the dispatcher under canonical and
    // sidekick_-prefixed names, exactly like the legacy storage handlers did.
    result = await tools.dispatchTool({ name: 'store', args: { key: 'alpha', value: 'one' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, undefined, 'store should execute through the dispatcher');
    assert.strictEqual(text(result), 'Stored key "alpha" (3 chars)');
    result = await tools.dispatchTool({ name: 'sidekick_get', args: { key: 'alpha' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, undefined, 'sidekick_-prefixed get should resolve to the extracted descriptor');
    assert.strictEqual(text(result), 'one');
    result = await tools.dispatchTool({ name: 'sidekick_delete', args: { key: 'alpha' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, undefined, 'sidekick_-prefixed delete should resolve to the extracted descriptor');
    assert.strictEqual(text(result), 'Deleted key "alpha"');
    result = await tools.dispatchTool({ name: 'get', args: { key: 'alpha' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, true, 'get after delete should report the key missing');
    assert.strictEqual(text(result), 'Key not found: alpha');

    result = await tools.dispatchTool({ name: 'sidekick_store', args: { key: 'proj_k1', value: 'v1', project: 'testproj' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, undefined, 'store with a project should execute');
    result = await tools.dispatchTool({ name: 'list_projects', args: {}, context: { source: 'mcp' } });
    assert.deepStrictEqual(JSON.parse(text(result)), ['testproj'], 'list_projects should surface the stored project');
    result = await tools.dispatchTool({ name: 'sidekick_get_by_project', args: { project: 'testproj' }, context: { source: 'mcp' } });
    const byProject = JSON.parse(text(result));
    assert.ok(Array.isArray(byProject) && byProject.length === 1, 'get_by_project should return the project keys');
    assert.strictEqual(byProject[0].key, 'proj_k1');
    assert.strictEqual(byProject[0].value, 'v1');

    result = await tools.dispatchTool({ name: 'store', args: { key: 'nope' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, true, 'missing value should fail descriptor validation');
    assert.strictEqual(result.code, 'validation_failed', 'validation should happen before the handler runs');

    // Batch and nested dispatch reach the extracted storage descriptors, and an
    // unknown tool inside a batch still fails without aborting the batch.
    result = await tools.dispatchTool({
      name: 'batch',
      args: { calls: [
        { tool: 'store', args: { key: 'batch_k', value: 'bv' } },
        { tool: 'sidekick_get', args: { key: 'batch_k' } },
        { tool: 'get_by_project', args: { project: 'testproj' } },
        { tool: 'batch', args: { calls: [{ tool: 'store', args: { key: 'nested_k', value: 'nv' } }] } },
        { tool: 'nope_not_real', args: {} },
      ] },
      context: { source: 'mcp' },
    });
    const batched = JSON.parse(text(result));
    assert.strictEqual(batched[0].error, false, 'batch should reach an extracted storage tool');
    assert.strictEqual(batched[0].result, 'Stored key "batch_k" (2 chars)');
    assert.strictEqual(batched[1].error, false, 'batch should reach a sidekick_-prefixed extracted storage tool');
    assert.strictEqual(batched[1].result, 'bv');
    assert.strictEqual(batched[2].error, false, 'batch should reach get_by_project');
    assert.strictEqual(batched[3].error, false, 'nested batch should execute');
    assert.ok(batched[3].result.includes('Stored key') && batched[3].result.includes('nested_k'), 'nested batch should reach the extracted storage tool');
    assert.strictEqual(batched[4].error, 'Unknown tool: nope_not_real', 'unknown batch tools should fail individually');

    // Policy and approval are enforced at the dispatcher for the extracted
    // storage family, not inside the handlers.
    process.env.SIDEKICK_BLOCKED_TOOLS = 'sidekick_get';
    result = await tools.dispatchTool({ name: 'sidekick_get', args: { key: 'proj_k1' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, true, 'policy denial should still apply to extracted storage tools');
    assert.strictEqual(result.code, 'policy_denied', 'policy must be enforced at the dispatcher, not in the handler');
    delete process.env.SIDEKICK_BLOCKED_TOOLS;

    process.env.SIDEKICK_APPROVAL_MODE = 'risky';
    process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = 'sidekick_store';
    result = await tools.dispatchTool({ name: 'sidekick_store', args: { key: 'approval_k', value: 'av' }, context: { source: 'mcp' } });
    assert.strictEqual(result.isError, true, 'approval-gated storage tool should not execute directly');
    assert.strictEqual(result.code, 'approval_required', 'approval must be enforced at the dispatcher for extracted families');
    assert.strictEqual(result.approvalRequired, true, 'result should signal that approval is required');
    assert.ok(result.approvalId, 'an approval record should be queued');
    assert.ok(tools.listApprovals({ status: 'pending' }).some(a => a.tool === 'sidekick_store'), 'a pending approval should exist for the extracted storage tool');
    process.env.SIDEKICK_APPROVAL_MODE = 'off';
    process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = '';

    console.log('Storage Family Tests passed');
  } finally {
    for (const [name, handler] of Object.entries(original)) redis[name] = handler;
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('Storage Family Tests FAILED');
  console.error(error);
  process.exit(1);
});
