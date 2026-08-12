const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-monitoring');
const ROOT = path.join(TEST_DATA_DIR, 'root');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const logPath = path.join(ROOT, 'app.log');
fs.writeFileSync(logPath, 'first\nmatch secret=token\nlast', 'utf8');

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'monitoring-test-secret-key';
delete process.env.SIDEKICK_ALLOWED_PATHS;
delete process.env.SIDEKICK_DENIED_PATHS;

const originalExecFileSync = childProcess.execFileSync;
let journalArgs;
childProcess.execFileSync = (command, args) => {
  journalArgs = { command, args };
  return 'journal line\n';
};

delete require.cache[require.resolve('../src/tools')];
const tools = require('../src/tools');
const legacy = require('../src/tools-legacy');
const family = require('../src/tools/families/monitoring');
childProcess.execFileSync = originalExecFileSync;
const db = require('../src/db');

const text = result => result.content[0].text;

console.log('Running Monitoring Family Tests...');

(async () => {
  try {
    const registry = tools.getBuiltinRegistry();
    const descriptor = registry.get('tail');
    assert.strictEqual(descriptor.family, 'monitoring');
    assert.strictEqual(descriptor.risk, 'medium');
    assert.strictEqual(descriptor.category, 'Efficiency');
    assert.strictEqual(descriptor.source, 'builtin');
    assert.strictEqual(typeof descriptor.handler, 'function');
    assert.strictEqual(legacy.TOOLS.tail, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(require('../src/tools/schemas').TOOL_SCHEMAS, 'tail'));
    assert.strictEqual(family.descriptors.length, 4);

    db.clearToolLogs();
    db.appendToolLog({ t: '2026-08-05T10:00:00.000Z', n: 'health', s: 'safe result', a: '{}', ok: true });
    db.appendToolLog({ t: '2026-08-05T11:00:00.000Z', n: 'status', s: 'secret=token', a: '{}', ok: false });
    let result = await family.sidekick_tail({ source: 'log.jsonl', lines: 2 });
    assert.ok(text(result).includes('[OK] health: safe result'));
    assert.ok(text(result).includes('[ERR] status: secret=[REDACTED]'));

    result = await family.sidekick_tail({ source: 'log', pattern: 'health', lines: 10 });
    assert.strictEqual(text(result), '10:00:00 [OK] health: safe result');

    result = await family.sidekick_tail({ source: 'journalctl', pattern: 'sidekick-agent', lines: 3 });
    assert.strictEqual(text(result), 'journal line\n');
    assert.deepStrictEqual(journalArgs, { command: 'journalctl', args: ['-u', 'sidekick-agent', '-n', '3', '--no-pager'] });

    result = await family.sidekick_tail({ source: logPath, pattern: 'match', lines: 1 });
    assert.strictEqual(text(result), 'match secret=[REDACTED]');

    result = await tools.dispatchTool({ name: 'sidekick_tail', args: { source: logPath, lines: 1 }, context: { source: 'mcp' } });
    assert.ok(text(result).includes('last'));
    result = await tools.dispatchTool({ name: 'tail', args: { source: logPath, lines: 1 }, context: { source: 'mcp' } });
    assert.ok(text(result).includes('last'));

    process.env.SIDEKICK_ALLOWED_PATHS = ROOT;
    result = await family.sidekick_tail({ source: path.join(TEST_DATA_DIR, 'outside.log') });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('Path blocked by policy'));

    result = await family.sidekick_tail({ source: path.join(ROOT, 'missing.log') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'File not found: ' + path.join(ROOT, 'missing.log'));

    console.log('Monitoring Family Tests passed');
  } finally {
    delete process.env.SIDEKICK_ALLOWED_PATHS;
    delete process.env.SIDEKICK_DENIED_PATHS;
    db.clearToolLogs();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('Monitoring Family Tests FAILED');
  console.error(error);
  process.exit(1);
});
