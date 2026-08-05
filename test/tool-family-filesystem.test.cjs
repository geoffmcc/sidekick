const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-filesystem');
const ROOT = path.join(TEST_DATA_DIR, 'root');
const OUTSIDE = path.join(TEST_DATA_DIR, 'outside.txt');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'one.txt'), 'safe value\nsecret=token', 'utf8');
fs.writeFileSync(path.join(ROOT, 'two.js'), 'const marker = true;\n', 'utf8');
fs.writeFileSync(path.join(ROOT, 'summary.txt'), 'first\nmiddle\nneedle\nlast\nsecret=token', 'utf8');
fs.writeFileSync(OUTSIDE, 'outside', 'utf8');

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'filesystem-test-secret-key';
delete process.env.SIDEKICK_ALLOWED_PATHS;
delete process.env.SIDEKICK_DENIED_PATHS;

delete require.cache[require.resolve('../src/tools')];

const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const family = require('../src/tools/families/filesystem');

const text = result => result.content[0].text;
const names = ['read', 'list', 'search', 'summarize'];

console.log('Running Filesystem Family Tests...');

(async () => {
  try {
    const registry = tools.getBuiltinRegistry();
    for (const name of names) {
      const descriptor = registry.get(name);
      assert.strictEqual(descriptor.family, 'filesystem');
      assert.strictEqual(descriptor.category, name === 'summarize' ? 'Efficiency' : 'Core');
      assert.strictEqual(descriptor.source, 'builtin');
      assert.strictEqual(typeof descriptor.handler, 'function');
      assert.strictEqual(legacy.TOOLS[name], undefined);
      assert.ok(!Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, name));
    }
    assert.strictEqual(registry.listInDefinitionOrder().length, 107);
    assert.deepStrictEqual(registry.listInDefinitionOrder().map(d => d.name), legacy.TOOL_DEFS.map(d => d.name));
    assert.strictEqual(family.descriptors.length, names.length);

    let result = await family.sidekick_read({ path: path.join(ROOT, 'one.txt') });
    assert.strictEqual(text(result), 'safe value\nsecret=[REDACTED]');

    result = await family.sidekick_list({ path: ROOT });
    assert.ok(text(result).includes('one.txt'));
    assert.ok(text(result).includes('two.js'));

    result = await family.sidekick_search({ pattern: 'marker', path: ROOT, include: '*.js' });
    assert.ok(text(result).includes('two.js'));
    assert.strictEqual(text(await family.sidekick_search({ pattern: 'missing', path: ROOT })), 'No matches found');

    const summaryPath = path.join(ROOT, 'summary.txt');
    result = await family.sidekick_summarize({ path: summaryPath, max_lines: 2 });
    assert.ok(text(result).startsWith('[Summary: 5 lines, strategy=head]\nfirst\nmiddle'));
    result = await family.sidekick_summarize({ path: summaryPath, max_lines: 2, strategy: 'tail' });
    assert.ok(text(result).includes('[Summary: 5 lines, strategy=tail]\nlast\nsecret=[REDACTED]'));
    result = await family.sidekick_summarize({ path: summaryPath, max_lines: 3, strategy: 'grep', pattern: 'needle' });
    assert.ok(text(result).includes('[Summary: 5 lines, strategy=grep, pattern=needle]'));
    assert.ok(text(result).includes('middle\nneedle\nlast'));
    result = await family.sidekick_summarize({ path: summaryPath, strategy: 'stats' });
    assert.ok(text(result).includes('strategy=stats'));
    assert.ok(text(result).includes('Non-empty lines: 5'));
    result = await family.sidekick_summarize({ path: summaryPath, strategy: 'grep' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'pattern required for grep strategy');
    result = await family.sidekick_summarize({ path: summaryPath, strategy: 'invalid' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'Invalid strategy. Use: head, tail, grep, stats');

    result = await tools.dispatchTool({ name: 'sidekick_read', args: { path: path.join(ROOT, 'two.js') }, context: { source: 'mcp' } });
    assert.ok(text(result).includes('marker'));
    result = await tools.dispatchTool({ name: 'sidekick_list', args: { path: ROOT }, context: { source: 'mcp' } });
    assert.ok(text(result).includes('one.txt'));
    result = await tools.dispatchTool({ name: 'sidekick_search', args: { pattern: 'marker', path: ROOT }, context: { source: 'mcp' } });
    assert.ok(text(result).includes('two.js'));
    result = await tools.dispatchTool({ name: 'sidekick_summarize', args: { path: path.join(ROOT, 'summary.txt'), max_lines: 1 }, context: { source: 'mcp' } });
    assert.ok(text(result).includes('strategy=head'));
    result = await tools.dispatchTool({ name: 'summarize', args: { path: path.join(ROOT, 'summary.txt'), max_lines: 1 }, context: { source: 'mcp' } });
    assert.ok(text(result).includes('strategy=head'));

    process.env.SIDEKICK_ALLOWED_PATHS = ROOT;
    result = await family.sidekick_read({ path: OUTSIDE });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('Path blocked by policy'));
    result = await family.sidekick_search({ pattern: 'outside', path: OUTSIDE });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('Path blocked by policy'));
    result = await family.sidekick_summarize({ path: OUTSIDE });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('Path blocked by policy'));

    result = await family.sidekick_read({ path: path.join(ROOT, 'missing.txt') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'File not found: ' + path.join(ROOT, 'missing.txt'));
    result = await family.sidekick_list({ path: path.join(ROOT, 'missing') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'Path not found: ' + path.join(ROOT, 'missing'));
    result = await family.sidekick_search({ pattern: 'outside', path: path.join(ROOT, 'missing') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'Path not found: ' + path.join(ROOT, 'missing'));
    result = await family.sidekick_summarize({ path: path.join(ROOT, 'missing.txt') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'File not found: ' + path.join(ROOT, 'missing.txt'));
    const largePath = path.join(ROOT, 'large.bin');
    fs.closeSync(fs.openSync(largePath, 'w'));
    fs.truncateSync(largePath, 50 * 1024 * 1024 + 1);
    result = await family.sidekick_summarize({ path: largePath });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'File too large to summarize (>50MB): ' + largePath);

    console.log('Filesystem Family Tests passed');
  } finally {
    delete process.env.SIDEKICK_ALLOWED_PATHS;
    delete process.env.SIDEKICK_DENIED_PATHS;
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('Filesystem Family Tests FAILED');
  console.error(error);
  process.exit(1);
});
