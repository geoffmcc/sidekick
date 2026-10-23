const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-tool-filesystem-'));
const ROOT = path.join(TEST_DATA_DIR, 'root');
const OUTSIDE = path.join(TEST_DATA_DIR, 'outside.txt');
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
process.env.SIDEKICK_ALLOWED_PATHS = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/tools')];

const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const rawFamily = require('../src/tools/families/filesystem');
const authorizedContext = require('./helpers/authorized-context').createServiceContext({ role: 'operator', source: 'mcp' });
const family = new Proxy(rawFamily, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function' || !String(property).startsWith('sidekick_')) return value;
    const name = String(property).replace(/^sidekick_/, '');
    return (...args) => tools.dispatchTool({ name, args: args[0] || {}, context: authorizedContext });
  },
});
const dispatchLocal = (name, args) => tools.dispatchTool({ name, args, context: { ...authorizedContext, allowNodeExecution: false } });

const text = result => result.content[0].text;
const names = ['read', 'list', 'search', 'summarize', 'filter', 'write', 'diff_files', 'find'];

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
    // Capability Packs v1 added `capability` and `workflow`: 103 -> 105.
    // B7 added `connector` (read-only connector inspection): 105 -> 106.
    // The workspace surface added `workspace` (workspaces + encrypted secrets): 106 -> 107.
    // Governed Browser Automation added `browser`: 107 -> 108; network scopes: 108 -> 109;
    // governed bulk memory maintenance: 109 -> 110.
    assert.strictEqual(registry.listInDefinitionOrder().length, 110);
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
    const manyLinesPath = path.join(ROOT, 'many-lines.txt');
    fs.writeFileSync(manyLinesPath, Array.from({ length: 700 }, (_, index) => `line-${index}`).join('\n'), 'utf8');
    result = await tools.dispatchTool({ name: 'summarize', args: { path: manyLinesPath, max_lines: 500 }, context: authorizedContext });
    assert.equal(text(result).split('\n').length, 501, 'summary output is capped without allocating a split array for every input line');
    result = await tools.dispatchTool({ name: 'summarize', args: { path: manyLinesPath, strategy: 'stats' }, context: authorizedContext });
    assert.ok(text(result).includes('Total lines: 700'));
    const oversizedSummary = await tools.dispatchTool({ name: 'summarize', args: { path: manyLinesPath, max_lines: 100000 }, context: authorizedContext });
    assert.equal(oversizedSummary.isError, true, 'schema rejects caller-supplied summary limits above the platform ceiling');
    result = await family.sidekick_summarize({ path: summaryPath, strategy: 'grep' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'pattern required for grep strategy');
    result = await family.sidekick_summarize({ path: summaryPath, strategy: 'invalid' });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).startsWith('Invalid arguments for summarize: strategy:'), text(result));

    result = await family.sidekick_filter({ path: summaryPath, pattern: 'needle' });
    assert.deepStrictEqual(JSON.parse(text(result)), [{ line: 3, text: 'needle' }]);
    result = await family.sidekick_filter({ path: path.join(ROOT, 'one.txt'), pattern: 'secret' });
    assert.ok(text(result).includes('secret=[REDACTED]'));
    assert.ok(!text(result).includes('secret=token'));
    result = await family.sidekick_filter({ path: ROOT, pattern: 'two', max_results: 1 });
    assert.strictEqual(JSON.parse(text(result)).length, 1);
    result = await tools.dispatchTool({ name: 'filter', args: { path: summaryPath, max_results: 1 }, context: authorizedContext });
    assert.strictEqual(JSON.parse(text(result)).length, 1, 'file filter caps its result count');
    assert.match(result.content[1]?.text || '', /result limit of 1 reached/, 'file filter reports when additional lines were omitted');
    result = await tools.dispatchTool({ name: 'filter', args: { path: ROOT, max_results: 2 }, context: authorizedContext });
    assert.strictEqual(JSON.parse(text(result)).length, 2, 'directory filter caps its result count');
    assert.match(result.content[1]?.text || '', /result limit of 2 reached/, 'directory filter reports partial results separately');
    result = await tools.dispatchTool({ name: 'filter', args: { path: ROOT, max_results: 100000 }, context: authorizedContext });
    assert.strictEqual(result.isError, true, 'filter schema rejects caller-supplied result ceilings above the platform limit');

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
    result = await family.sidekick_find({ path: ROOT, size_min: '10KB' });
    assert.deepStrictEqual(JSON.parse(text(result)), []);

    result = await tools.dispatchTool({ name: 'sidekick_read', args: { path: path.join(ROOT, 'two.js') }, context: authorizedContext });
    assert.ok(text(result).includes('marker'));
    result = await tools.dispatchTool({ name: 'sidekick_list', args: { path: ROOT }, context: authorizedContext });
    assert.ok(text(result).includes('one.txt'));
    if (process.platform !== 'win32') {
      const linkTarget = path.join(TEST_DATA_DIR, 'list-metadata-target.txt');
      const linkPath = path.join(ROOT, 'metadata-link.txt');
      fs.writeFileSync(linkTarget, 'x'.repeat(4096));
      fs.symlinkSync(linkTarget, linkPath);
      result = await tools.dispatchTool({ name: 'sidekick_list', args: { path: ROOT }, context: authorizedContext });
      const linkLine = text(result).split('\n').find(line => line.endsWith('metadata-link.txt'));
      assert.ok(linkLine?.startsWith('OTHER'), 'directory listing identifies symlinks without following them');
      assert.match(linkLine, new RegExp(`\\b${fs.lstatSync(linkPath).size}\\b`), 'listing reports link metadata, not target size');
      assert.doesNotMatch(linkLine, new RegExp(`\\b${fs.statSync(linkPath).size}\\b`), 'listing does not disclose target file metadata');
    }
    result = await tools.dispatchTool({ name: 'sidekick_search', args: { pattern: 'marker', path: ROOT }, context: authorizedContext });
    assert.ok(text(result).includes('two.js'));
    result = await tools.dispatchTool({ name: 'sidekick_summarize', args: { path: path.join(ROOT, 'summary.txt'), max_lines: 1 }, context: authorizedContext });
    assert.ok(text(result).includes('strategy=head'));
    result = await tools.dispatchTool({ name: 'summarize', args: { path: path.join(ROOT, 'summary.txt'), max_lines: 1 }, context: authorizedContext });
    assert.ok(text(result).includes('strategy=head'));
    result = await tools.dispatchTool({ name: 'sidekick_find', args: { path: ROOT, name: '*.js' }, context: authorizedContext });
    assert.strictEqual(JSON.parse(text(result)).length, 1);

    for (let index = 0; index < 505; index++) {
      fs.writeFileSync(path.join(ROOT, `bounded_${String(index).padStart(3, '0')}.txt`), '');
    }
    result = await tools.dispatchTool({ name: 'sidekick_list', args: { path: ROOT }, context: authorizedContext });
    assert.ok(text(result).includes('[truncated: showing the first 500 entries]'), 'directory listing reports its fixed entry ceiling');
    result = await tools.dispatchTool({ name: 'sidekick_find', args: { path: ROOT, name: 'bounded_*.txt', max_results: 500 }, context: authorizedContext });
    assert.strictEqual(JSON.parse(text(result)).length, 500, 'file finder cannot return more than its fixed result ceiling');
    assert.match(result.content[1]?.text || '', /result limit of 500 reached/, 'the result remains valid JSON and reports a partial search separately');
    const oversizedFind = await tools.dispatchTool({ name: 'sidekick_find', args: { path: ROOT, max_results: 100000 }, context: authorizedContext });
    assert.strictEqual(oversizedFind.isError, true, 'schema rejects caller-supplied result ceilings above the platform limit');

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

    result = await dispatchLocal('read', { path: path.join(ROOT, 'missing.txt') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'File not found: ' + path.join(ROOT, 'missing.txt'));
    result = await dispatchLocal('list', { path: path.join(ROOT, 'missing') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'Path not found: ' + path.join(ROOT, 'missing'));
    result = await dispatchLocal('search', { pattern: 'outside', path: path.join(ROOT, 'missing') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'Path not found: ' + path.join(ROOT, 'missing'));
    result = await dispatchLocal('summarize', { path: path.join(ROOT, 'missing.txt') });
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
    try { require('../src/db').closeDatabase(); } catch {}
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('Filesystem Family Tests FAILED');
  console.error(error);
  process.exit(1);
});
