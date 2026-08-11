const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-data-utilities');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(TEST_DATA_DIR, 'data.json'), JSON.stringify({ database: { host: 'localhost', password: 'secret', clientSecret: 'client-secret' }, items: [{ name: 'first' }] }), 'utf8');
fs.writeFileSync(path.join(TEST_DATA_DIR, 'data.yaml'), 'database:\n  host: localhost\nitems:\n  - name: first\n', 'utf8');
fs.writeFileSync(path.join(TEST_DATA_DIR, 'data.ini'), '[database]\nhost=localhost\n', 'utf8');
fs.writeFileSync(path.join(TEST_DATA_DIR, 'data.xml'), '<root><item>value</item></root>', 'utf8');
fs.writeFileSync(path.join(TEST_DATA_DIR, 'data.txt'), '{"fallback":true}', 'utf8');

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'data-utilities-test-secret-key';
delete process.env.SIDEKICK_BLOCKED_TOOLS;

delete require.cache[require.resolve('../src/tools')];

const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const family = require('../src/tools/families/data-utilities');
const { detectFormat, parseCSV } = require('../src/core/format');
const { dispatchTool } = tools;

console.log('Running Data Utilities Family Tests...');

const text = result => result.content[0].text;

(async () => {
  try {
    // --- Boundary: the data-utilities module owns these tools now ---

    for (const name of ['parse', 'extract', 'transform', 'diff', 'validate', 'template']) {
      assert.ok(!legacy.TOOLS[name], `${name} should not have a live legacy handler`);
      assert.strictEqual(tools.getBuiltinRegistry().get(name), undefined, `${name} should be absent before module provisioning`);
    }

    const provision = require('../src/modules/builtin-modules').provisionBuiltinModules();
    assert.deepStrictEqual(provision.errors, [], 'Builtin module provisioning should succeed');

    for (const name of ['parse', 'extract', 'transform', 'diff', 'validate', 'template']) {
      const descriptor = tools.getBuiltinRegistry().get(name);
      assert.ok(descriptor, `${name} should resolve after module provisioning`);
      assert.strictEqual(descriptor.source, 'module:data-utilities', `${name} should be owned by the data-utilities module`);
      assert.strictEqual(descriptor.risk, name === 'extract' ? 'medium' : 'low', `${name} risk should be preserved`);
      assert.strictEqual(descriptor.category, 'Data Pipeline', `${name} should stay in the Data Pipeline category`);
      assert.ok(!Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, name), `${name} should have one schema owner`);
    }

    // --- Behavior preservation: parse ---

    assert.deepStrictEqual(
      JSON.parse(text(await family.sidekick_parse({ input: '{"a":1,"b":[1,2]}' }))),
      { a: 1, b: [1, 2] },
      'parse should auto-detect JSON'
    );
    assert.deepStrictEqual(
      JSON.parse(text(await family.sidekick_parse({ input: 'a: 1\nb: two\n' }))),
      { a: 1, b: 'two' },
      'parse should auto-detect YAML'
    );
    assert.deepStrictEqual(
      JSON.parse(text(await family.sidekick_parse({ input: 'a,b\n1,2\n' }))),
      [{ a: '1', b: '2' }],
      'parse should auto-detect CSV'
    );
    assert.deepStrictEqual(
      JSON.parse(text(await family.sidekick_parse({ input: '[sec]\nk=v\n' }))),
      { sec: { k: 'v' } },
      'parse should auto-detect INI'
    );

    let result = await family.sidekick_parse({ input: '' });
    assert.ok(result.isError, 'parse should reject empty input');
    assert.strictEqual(text(result), 'input required');

    result = await family.sidekick_parse({ input: 'zzz' });
    assert.ok(result.isError, 'parse should reject undetectable input');
    assert.ok(text(result).startsWith('Could not detect format'), 'parse should explain detection failure');

    result = await family.sidekick_parse({ input: 'not json', format: 'json' });
    assert.ok(result.isError, 'parse should surface parse errors');
    assert.ok(text(result).startsWith('Parse error (json):'), 'parse error should name the format');

    result = await family.sidekick_parse({ input: '{"a":1}', format: 'bogus' });
    assert.ok(result.isError, 'parse should reject an unsupported explicit format');
    assert.strictEqual(text(result), 'Unsupported format: bogus');

    // --- Behavior preservation and hardening: extract ---

    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'data.json'), fields: 'database.host,items[0].name,missing' });
    assert.deepStrictEqual(JSON.parse(text(result)), { 'database.host': 'localhost', 'items[0].name': 'first', missing: null });
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'data.yaml'), fields: ['database.host'] });
    assert.deepStrictEqual(JSON.parse(text(result)), { 'database.host': 'localhost' });
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'data.ini') });
    assert.deepStrictEqual(JSON.parse(text(result)), { database: { host: 'localhost' } });
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'data.xml') });
    assert.deepStrictEqual(JSON.parse(text(result)), { root: { item: 'value' } });
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'data.txt'), fields: 'fallback' });
    assert.deepStrictEqual(JSON.parse(text(result)), { fallback: 'true' });
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'data.json') });
    assert.ok(text(result).includes('"password": "[REDACTED]"'));
    assert.ok(text(result).includes('"clientSecret": "[REDACTED]"'));
    assert.ok(!text(result).includes('password":"secret"'));
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'data.json'), fields: ['constructor', '__proto__'] });
    assert.deepStrictEqual(JSON.parse(text(result)), JSON.parse('{"constructor":null,"__proto__":null}'));
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'missing.json') });
    assert.ok(result.isError);
    assert.strictEqual(text(result), 'File not found: ' + path.join(TEST_DATA_DIR, 'missing.json'));
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'bad.json'), '{bad', 'utf8');
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'bad.json') });
    assert.ok(result.isError);
    assert.ok(text(result).startsWith('Parse error:'));

    // --- Behavior preservation: transform ---

    assert.strictEqual(text(await family.sidekick_transform({ action: 'filter', input: 'keep\ndrop\nkeep', pattern: '^keep$' })), 'keep\nkeep');
    assert.deepStrictEqual(JSON.parse(text(await family.sidekick_transform({ action: 'filter', input: '["keep","drop"]', pattern: 'keep' }))), ['keep']);
    assert.strictEqual(text(await family.sidekick_transform({ action: 'extract', input: '{"a":{"b":[1,2]}}', field: 'a.b.[]' })), '[\n  1,\n  2\n]');
    assert.deepStrictEqual(JSON.parse(text(await family.sidekick_transform({ action: 'sort', input: '[3,1,2]' }))), [1, 2, 3]);
    assert.deepStrictEqual(JSON.parse(text(await family.sidekick_transform({ action: 'sort', input: '[{"n":2},{"n":1}]', key: 'n' }))), [{ n: 1 }, { n: 2 }]);
    assert.strictEqual(text(await family.sidekick_transform({ action: 'format', input: '[{"a":1,"b":"x"}]', format: 'csv' })), 'a,b\n1,x');
    assert.ok(text(await family.sidekick_transform({ action: 'format', input: '[{"a":1,"b":"x"}]', format: 'table' })).includes('a | b'));
    assert.deepStrictEqual(JSON.parse(text(await family.sidekick_transform({ action: 'map', input: '[1,{"a":2}]', key: 'tag', value: 'yes' }))), [{ tag: 'yes', original: 1 }, { a: 2, tag: 'yes' }]);
    assert.strictEqual(text(await family.sidekick_transform({ action: 'extract', input: '{"a":1}', field: 'constructor' })), undefined);
    result = await family.sidekick_transform({ action: 'filter', input: 'x' });
    assert.ok(result.isError);
    result = await family.sidekick_transform({ action: 'format', input: 'x', format: 'invalid' });
    assert.ok(result.isError);
    result = await family.sidekick_transform({ action: 'sort', input: '{}' });
    assert.ok(result.isError);

    // --- Behavior preservation: diff ---

    assert.strictEqual(
      text(await family.sidekick_diff({ old_text: '{"a":1}', new_text: '{"a":2}' })),
      '~ a:\n- 1\n+ 2',
      'diff should structurally compare JSON in unified format'
    );
    assert.strictEqual(
      text(await family.sidekick_diff({ old_text: '{"a":1}', new_text: '{"a":2}', format: 'summary' })),
      'Summary: 0 added, 0 removed, 1 modified',
      'diff summary should count change types'
    );
    assert.deepStrictEqual(
      JSON.parse(text(await family.sidekick_diff({ old_text: '{"a":1}', new_text: '{"b":1}', format: 'json' }))),
      [{ type: 'removed', path: 'a', value: 1 }, { type: 'added', path: 'b', value: 1 }],
      'diff json format should emit structured changes'
    );
    assert.strictEqual(
      text(await family.sidekick_diff({ old_text: 'a\nb', new_text: 'a\nc', type: 'text' })),
      '~ line 2:\n- "b"\n+ "c"',
      'diff should fall back to line-based text diffing'
    );

    result = await family.sidekick_diff({ old_text: 'x' });
    assert.ok(result.isError, 'diff should require both sides');
    assert.strictEqual(text(result), 'old_text and new_text required');

    result = await family.sidekick_diff({ old_text: 'bad', new_text: 'bad', type: 'json' });
    assert.ok(result.isError, 'diff should surface JSON parse errors when json type is forced');
    assert.ok(text(result).startsWith('JSON parse error:'));

    // --- Behavior preservation: validate ---

    assert.strictEqual(
      text(await family.sidekick_validate({ data: '{"a":1}', schema: '{"type":"object","properties":{"a":{"type":"number"}}}' })),
      '✓ Validation passed',
      'validate should accept conforming data'
    );

    result = await family.sidekick_validate({ data: '{"a":"x"}', schema: '{"type":"object","properties":{"a":{"type":"number"}}}' });
    assert.ok(text(result).startsWith('✗ Validation failed:'), 'validate should report a schema violation');
    assert.ok(!result.isError, 'a schema violation is a result, not a tool error');

    result = await family.sidekick_validate({ data: '{"a":1}' });
    assert.ok(result.isError, 'validate should require a schema');
    assert.strictEqual(text(result), 'data and schema required');

    result = await family.sidekick_validate({ data: '{"a":1}', schema: '{"type":"nonsense"}' });
    assert.ok(result.isError, 'validate should surface an unusable schema');
    assert.ok(text(result).startsWith('Validation error:'));

    // --- Behavior preservation: template ---

    assert.strictEqual(
      text(await family.sidekick_template({ template: 'Hello {{name}}', data: '{"name":"World"}' })),
      'Hello World',
      'template should render with JSON-string data'
    );
    assert.strictEqual(
      text(await family.sidekick_template({ template: 'Hello {{name}}', data: { name: 'Obj' } })),
      'Hello Obj',
      'template should render with object data'
    );
    assert.strictEqual(
      text(await family.sidekick_template({ template: '{{raw}}', data: '{"raw":"<b>&</b>"}' })),
      '&lt;b&gt;&amp;&lt;/b&gt;',
      'template should keep Handlebars HTML escaping'
    );

    result = await family.sidekick_template({});
    assert.ok(result.isError, 'template should require a template');
    assert.strictEqual(text(result), 'template required');

    result = await family.sidekick_template({ template: 'x', data: 'not-json' });
    assert.ok(result.isError, 'template should surface bad data JSON');
    assert.ok(text(result).startsWith('Data parse error:'));

    // --- Shared format helpers moved to src/core/format ---

    assert.strictEqual(detectFormat('{"a":1}'), 'json');
    assert.strictEqual(detectFormat('a: 1\nb: 2'), 'yaml');
    assert.strictEqual(detectFormat('<r><a/></r>'), 'xml');
    assert.strictEqual(detectFormat('zzz'), null);
    assert.deepStrictEqual(parseCSV('a,b\n1,2\n'), [{ a: '1', b: '2' }]);
    assert.deepStrictEqual(parseCSV('"a","b"\n1,2\n'), [{ a: '1', b: '2' }], 'parseCSV should strip surrounding quotes');

    // --- Integration: the dispatcher still owns execution for the family ---

    result = await dispatchTool({ name: 'sidekick_parse', args: { input: '{"a":1}' }, context: { source: 'mcp', requestId: 'req_du_ok' } });
    assert.strictEqual(result.isError, undefined, 'dispatcher should execute an extracted family tool');
    assert.deepStrictEqual(JSON.parse(text(result)), { a: 1 });

    result = await dispatchTool({ name: 'sidekick_parse', args: {}, context: { source: 'mcp', requestId: 'req_du_invalid' } });
    assert.ok(result.isError, 'dispatcher should reject args that fail the descriptor schema');
    assert.strictEqual(result.code, 'validation_failed', 'schema validation should happen before the handler runs');
    result = await dispatchTool({ name: 'sidekick_extract', args: { path: path.join(TEST_DATA_DIR, 'data.json'), fields: 'database.host' }, context: { source: 'mcp', requestId: 'req_du_extract' } });
    assert.deepStrictEqual(JSON.parse(text(result)), { 'database.host': 'localhost' });
    result = await dispatchTool({ name: 'sidekick_transform', args: { action: 'sort', input: '[2,1]' }, context: { source: 'mcp', requestId: 'req_du_transform' } });
    assert.deepStrictEqual(JSON.parse(text(result)), [1, 2]);
    result = await dispatchTool({ name: 'transform', args: { action: 'map', input: '[1]', key: 'ok', value: 'yes' }, context: { source: 'mcp', requestId: 'req_du_transform_alias' } });
    assert.deepStrictEqual(JSON.parse(text(result)), [{ ok: 'yes', original: 1 }]);
    result = await dispatchTool({ name: 'sidekick_transform', args: { action: 'format', input: '[1]', format: 'invalid' }, context: { source: 'mcp', requestId: 'req_du_transform_invalid_format' } });
    assert.ok(result.isError);
    assert.strictEqual(text(result), 'Unknown format. Use: json, csv, table, text');
    result = await dispatchTool({ name: 'extract', args: { path: path.join(TEST_DATA_DIR, 'data.json'), fields: 'database.host' }, context: { source: 'mcp', requestId: 'req_du_extract_alias' } });
    assert.deepStrictEqual(JSON.parse(text(result)), { 'database.host': 'localhost' });
    const allowedPath = path.join(TEST_DATA_DIR, 'allowed');
    fs.mkdirSync(allowedPath, { recursive: true });
    process.env.SIDEKICK_ALLOWED_PATHS = allowedPath;
    result = await family.sidekick_extract({ path: path.join(TEST_DATA_DIR, 'data.json') });
    assert.ok(result.isError, 'extract should enforce path policy');
    assert.ok(text(result).includes('Path blocked by policy'));
    delete process.env.SIDEKICK_ALLOWED_PATHS;

    process.env.SIDEKICK_BLOCKED_TOOLS = 'sidekick_template';
    result = await dispatchTool({ name: 'sidekick_template', args: { template: 'x' }, context: { source: 'mcp', requestId: 'req_du_policy' } });
    assert.ok(result.isError, 'policy denial should still apply to extracted family tools');
    assert.strictEqual(result.code, 'policy_denied', 'policy must be enforced at the dispatcher, not in the handler');
    delete process.env.SIDEKICK_BLOCKED_TOOLS;

    process.env.SIDEKICK_APPROVAL_MODE = 'risky';
    process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = 'sidekick_parse';
    result = await dispatchTool({ name: 'sidekick_parse', args: { input: '{"a":1}' }, context: { source: 'mcp', requestId: 'req_du_approval' } });
    assert.ok(result.isError, 'approval-gated family tool should not execute directly');
    assert.strictEqual(result.code, 'approval_required', 'approval must be enforced at the dispatcher for extracted families');
    assert.ok(result.approvalRequired, 'result should signal that approval is required');
    assert.ok(result.approvalId, 'an approval record should be queued');
    assert.ok(tools.listApprovals({ status: 'pending' }).some(a => a.tool === 'sidekick_parse'), 'a pending approval should exist for the extracted tool');
    process.env.SIDEKICK_APPROVAL_MODE = 'off';
    process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = '';

    // Regression: batch resolves builtin names from TOOL_DEFS, so tools whose
    // handlers moved into a family stay reachable. Before the data-utilities
    // extraction this gate read the legacy TOOLS map and would report
    // "Unknown tool" for every extracted tool.
    const batchResult = await legacy.TOOLS.batch({
      calls: [
        { tool: 'parse', args: { input: '{"a":1}' } },
        { tool: 'sidekick_template', args: { template: 'hi {{n}}', data: '{"n":"x"}' } },
        { tool: 'respond', args: { text: 'ok' } },
        { tool: 'hash', args: { input: 'abc' } },
        { tool: 'constructor', args: {} },
        { tool: 'nope_not_real', args: {} },
      ],
    });
    const batched = JSON.parse(text(batchResult));
    assert.ok(!batched[0].error, 'batch should reach an extracted family tool');
    assert.strictEqual(batched[0].result, '{\n  "a": 1\n}', 'batch should return the extracted tool result');
    assert.ok(!batched[1].error, 'batch should accept a sidekick_-prefixed extracted tool');
    assert.ok(!batched[2].error, 'batch should reach the utility family');
    assert.ok(!batched[3].error, 'batch should still reach legacy-owned tools');
    assert.strictEqual(batched[4].error, 'Unknown tool: constructor', 'batch must not resolve inherited Object properties');
    assert.strictEqual(batched[5].error, 'Unknown tool: nope_not_real', 'batch should still reject unknown tools');

    // Compatibility surface: module-owned tools are deliberately absent from
    // the static builtin compatibility map — the dispatcher (exercised above)
    // is their only execution path.
    for (const name of ['parse', 'extract', 'transform', 'template']) {
      assert.strictEqual(tools.TOOLS[name], undefined, `compatibility TOOLS map should not own module tool ${name}`);
    }

    console.log('Data Utilities Family Tests passed');
  } catch (e) {
    console.error('Data Utilities Family Tests FAILED');
    console.error(e);
    process.exit(1);
  }
})();
