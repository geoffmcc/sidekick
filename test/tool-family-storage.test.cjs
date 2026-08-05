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
    for (const [name, risk, category] of [['cache', 'low', 'Efficiency'], ['redis', 'medium', 'Storage']]) {
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
