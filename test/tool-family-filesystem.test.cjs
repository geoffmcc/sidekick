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
fs.writeFileSync(path.join(ROOT, 'compare.txt'), 'safe value\nchanged\nextra', 'utf8');
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
const names = ['read', 'list', 'search', 'summarize', 'filter', 'diff_files', 'find'];

console.log('Running Filesystem Family Tests...');

(async () => {
  try {
    const registry = tools.getBuiltinRegistry();
    for (const name of names) {
      const descriptor = registry.get(name);
      assert.strictEqual(descriptor.family, 'filesystem');
      const category = name === 'summarize' || name === 'filter' || name === 'find' ? 'Efficiency' : name === 'diff_files' ? 'Data Pipeline' : 'Core';
      assert.strictEqual(descriptor.category, category);
      assert.strictEqual(descriptor.source, 'builtin');
      assert.strictEqual(typeof descriptor.handler, 'function');
      assert.strictEqual(legacy.TOOLS[name], undefined);
      assert.ok(!Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, name));
    }
    assert.strictEqual(registry.listInDefinitionOrder().length, 101);
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

    result = await family.sidekick_filter({ path: summaryPath, pattern: 'needle' });
    assert.deepStrictEqual(JSON.parse(text(result)), [{ line: 3, text: 'needle' }]);
    result = await family.sidekick_filter({ path: path.join(ROOT, 'one.txt'), pattern: 'secret' });
    assert.ok(text(result).includes('secret=[REDACTED]'));
    assert.ok(!text(result).includes('secret=token'));
    result = await family.sidekick_filter({ path: ROOT, pattern: 'two', max_results: 1 });
    assert.strictEqual(JSON.parse(text(result)).length, 1);

    const comparePath = path.join(ROOT, 'compare.txt');
    result = await family.sidekick_diff_files({ path_a: path.join(ROOT, 'one.txt'), path_b: comparePath, format: 'summary' });
    assert.deepStrictEqual(JSON.parse(text(result)), { file_a: path.join(ROOT, 'one.txt'), file_b: comparePath, lines_a: 2, lines_b: 3, added: 1, removed: 0, changed: 1 });
    result = await family.sidekick_diff_files({ path_a: path.join(ROOT, 'one.txt'), path_b: comparePath });
    assert.ok(text(result).includes('- 2: secret=[REDACTED]'));
    assert.ok(text(result).includes('+ 2: changed'));

    result = await family.sidekick_find({ path: ROOT, name: '*.js', content: 'marker' });
    assert.deepStrictEqual(JSON.parse(text(result)).map(entry => path.basename(entry.path)), ['two.js']);
    fs.writeFileSync(path.join(ROOT, 'two.js.bak'), 'marker', 'utf8');
    result = await family.sidekick_find({ path: ROOT, name: '*.js' });
    assert.deepStrictEqual(JSON.parse(text(result)).map(entry => path.basename(entry.path)), ['two.js']);
    result = await family.sidekick_find({ path: ROOT, size_min: '1KB' });
    assert.deepStrictEqual(JSON.parse(text(result)), []);

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
    result = await tools.dispatchTool({ name: 'sidekick_find', args: { path: ROOT, name: '*.js' }, context: { source: 'mcp' } });
    assert.strictEqual(JSON.parse(text(result)).length, 1);

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
    result = await family.sidekick_find({ path: TEST_DATA_DIR });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('Path blocked by policy'));
    result = await family.sidekick_diff_files({ path_a: OUTSIDE, path_b: path.join(ROOT, 'one.txt') });
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
