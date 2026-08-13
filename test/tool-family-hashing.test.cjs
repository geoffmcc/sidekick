const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-hashing');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'hashing-test-secret-key';
for (const key of ['SIDEKICK_ALLOWED_PATHS', 'SIDEKICK_DENIED_PATHS']) delete process.env[key];

delete require.cache[require.resolve('../src/tools')];

const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const family = require('../src/tools/families/hashing');
const { dispatchTool } = tools;

console.log('Running Hashing Family Tests...');

const text = result => result.content[0].text;
const digest = (algorithm, value) => crypto.createHash(algorithm).update(value).digest('hex');
const filePath = path.join(TEST_DATA_DIR, 'fixture.txt');
const missingPath = path.join(TEST_DATA_DIR, 'missing.txt');
fs.writeFileSync(filePath, 'file contents\n', 'utf8');

(async () => {
  try {
    const descriptor = tools.getBuiltinRegistry().get('hash');
    assert.strictEqual(descriptor.family, 'hashing');
    assert.strictEqual(descriptor.category, 'Data Pipeline');
    assert.strictEqual(descriptor.source, 'builtin');
    assert.strictEqual(descriptor.risk, 'low');
    assert.deepStrictEqual(descriptor.args, legacy.TOOL_DEFS.find(def => def.name === 'hash').args);
    assert.strictEqual(typeof descriptor.handler, 'function');
    assert.strictEqual(legacy.TOOLS.hash, undefined, 'legacy handler map must not retain hash');
    assert.strictEqual(family.descriptors.length, 1);
    assert.strictEqual(family.descriptors[0].handler, family.sidekick_hash);
    assert.ok(!fs.readFileSync(path.join(__dirname, '../src/tools/families/hashing.js'), 'utf8').includes('tools-legacy'));

    // Default SHA-256 and all supported algorithms preserve the existing text.
    assert.strictEqual(text(await family.sidekick_hash({ input: 'abc' })), `SHA256: ${digest('sha256', 'abc')}`);
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
      assert.strictEqual(
        text(await family.sidekick_hash({ input: 'abc', algorithm })),
        `${algorithm.toUpperCase()}: ${digest(algorithm, 'abc')}`
      );
    }

    // File input takes precedence over input when both are present.
    assert.strictEqual(
      text(await family.sidekick_hash({ path: filePath, input: 'not the file' })),
      `SHA256: ${digest('sha256', fs.readFileSync(filePath))}`
    );

    const expected = digest('sha256', 'abc');
    assert.strictEqual(text(await family.sidekick_hash({ input: 'abc', verify: expected })), `✓ Hash matches (sha256: ${expected})`);
    assert.strictEqual(text(await family.sidekick_hash({ input: 'abc', verify: expected.toUpperCase() })), `✓ Hash matches (sha256: ${expected})`);
    const mismatch = await family.sidekick_hash({ input: 'abc', verify: 'not-a-digest' });
    assert.strictEqual(text(mismatch), `✗ Hash mismatch\nExpected: not-a-digest\nActual:   ${expected}`);
    assert.strictEqual(mismatch.isError, undefined, 'verification mismatch remains a result, not a handler error');

    const invalidAlgorithm = await family.sidekick_hash({ input: 'abc', algorithm: 'sha224' });
    assert.strictEqual(text(invalidAlgorithm), 'Invalid algorithm. Use: md5, sha1, sha256, sha512');
    assert.strictEqual(invalidAlgorithm.isError, true);
    const missingInput = await family.sidekick_hash({});
    assert.strictEqual(text(missingInput), 'input or path required');
    assert.strictEqual(missingInput.isError, true);
    const readFailure = await family.sidekick_hash({ path: missingPath });
    assert.ok(text(readFailure).startsWith('File read error:'));
    assert.strictEqual(readFailure.isError, true);

    // The shared path-policy module remains the filesystem security boundary.
    process.env.SIDEKICK_ALLOWED_PATHS = TEST_DATA_DIR;
    assert.ok(!(await family.sidekick_hash({ path: filePath })).isError);
    const deniedPath = path.join(path.dirname(TEST_DATA_DIR), 'outside-hash.txt');
    fs.writeFileSync(deniedPath, 'outside', 'utf8');
    try {
      const denied = await family.sidekick_hash({ path: deniedPath });
      assert.strictEqual(denied.isError, true);
      assert.ok(text(denied).includes('Path blocked by policy'));
    } finally {
      fs.rmSync(deniedPath, { force: true });
    }

    // Dispatcher execution accepts both canonical and sidekick_-prefixed names.
    let result = await dispatchTool({ name: 'hash', args: { input: 'abc' }, context: { source: 'mcp', requestId: 'hash_canonical' } });
    assert.strictEqual(text(result), `SHA256: ${expected}`);
    result = await dispatchTool({ name: 'sidekick_hash', args: { input: 'abc' }, context: { source: 'mcp', requestId: 'hash_alias' } });
    assert.strictEqual(text(result), `SHA256: ${expected}`);

    // Batch is a generic nested execution path and must recognize the legacy
    // definition anchor even though hash is absent from legacy.TOOLS.
    const batch = await tools.TOOLS.batch({ calls: [
      { tool: 'hash', args: { input: 'abc' } },
      { tool: 'sidekick_hash', args: { input: 'abc', algorithm: 'md5' } },
    ] });
    const batchResults = JSON.parse(text(batch));
    assert.strictEqual(batchResults[0].error, false);
    assert.strictEqual(batchResults[0].result, `SHA256: ${expected}`);
    assert.strictEqual(batchResults[1].error, false);
    assert.strictEqual(batchResults[1].result, `MD5: ${digest('md5', 'abc')}`);

    const registry = tools.getBuiltinRegistry();
    // Capability Packs v1 added `capability` and `workflow`: 103 -> 105.
    assert.strictEqual(registry.listInDefinitionOrder().length, 105);
    assert.deepStrictEqual(
      registry.listInDefinitionOrder().map(tool => tool.name),
      legacy.TOOL_DEFS.map(def => def.name),
      'hash extraction must preserve TOOL_DEFS definition order'
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, 'hash'), false);

    console.log('Hashing Family Tests passed');
  } finally {
    delete process.env.SIDEKICK_ALLOWED_PATHS;
    delete process.env.SIDEKICK_DENIED_PATHS;
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('Hashing Family Tests FAILED');
  console.error(error);
  process.exit(1);
});
