const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-tool-monitoring-'));
const ROOT = path.join(TEST_DATA_DIR, 'root');
fs.mkdirSync(ROOT, { recursive: true });
const logPath = path.join(ROOT, 'app.log');
fs.writeFileSync(logPath, 'first\nmatch secret=token\nlast', 'utf8');

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'monitoring-test-secret-key';
delete process.env.SIDEKICK_ALLOWED_PATHS;
delete process.env.SIDEKICK_DENIED_PATHS;
process.env.SIDEKICK_MCP_ALLOWED_PATHS = ROOT;

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
const authorizedContext = require('./helpers/authorized-context').createServiceContext({ role: 'operator', source: 'mcp' });
const runAuthorized = (name, args) => tools.dispatchTool({ name, args, context: authorizedContext });
const runWithContext = require('../src/tools/context').runWithContext;
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

    assert.strictEqual((await family.sidekick_snapshot({ action: 'list' })).code, 'unauthenticated');
    assert.strictEqual((await family.sidekick_timeline({ action: 'build' })).code, 'unauthenticated');
    assert.strictEqual((await family.sidekick_baseline({ action: 'status', metric_name: 'cpu' })).code, 'unauthenticated');
    assert.strictEqual((await runWithContext(authorizedContext, () => family.sidekick_snapshot({ action: 'list' }))).code, 'canonical_dispatch_required',
      'an authorized direct handler call must not bypass canonical policy');
    assert.strictEqual((await runAuthorized('snapshot', { action: 'list' })).isError, undefined,
      'canonical dispatch permits an authorized snapshot read');
    assert.strictEqual((await runAuthorized('baseline', { action: 'status', metric_name: 'cpu' })).code, 'authorization_denied',
      'high-risk baseline access requires tools.execute_high even with an authenticated principal');

    db.clearToolLogs();
    db.appendToolLog({ t: '2026-08-05T10:00:00.000Z', n: 'health', s: 'safe result', a: '{}', ok: true });
    db.appendToolLog({ t: '2026-08-05T11:00:00.000Z', n: 'status', s: 'secret=token', a: '{}', ok: false });
    let result = await family.sidekick_tail({ source: 'log.jsonl', lines: 2 });
    assert.strictEqual(result.code, 'unauthenticated', 'direct tail handlers require an authenticated execution identity');
    result = await runAuthorized('tail', { source: 'log.jsonl', lines: 2 });
    assert.ok(text(result).includes('[OK] health: safe result'));
    assert.ok(text(result).includes('[ERR] status: secret=[REDACTED]'));

    db.clearToolLogs();
    db.appendToolLog({ t: '2026-08-05T10:00:00.000Z', n: 'health', s: 'safe result', a: '{}', ok: true });
    result = await runAuthorized('tail', { source: 'log', pattern: 'health', lines: 10 });
    assert.ok(text(result).endsWith('10:00:00 [OK] health: safe result'));

    result = await runAuthorized('tail', { source: 'journalctl', pattern: 'sidekick-agent', lines: 3 });
    assert.strictEqual(text(result), 'journal line\n');
    assert.deepStrictEqual(journalArgs, { command: 'journalctl', args: ['-u', 'sidekick-agent', '-n', '3', '--no-pager'] });

    result = await runAuthorized('tail', { source: logPath, pattern: 'match', lines: 1 });
    assert.strictEqual(text(result), 'match secret=[REDACTED]');

    result = await tools.dispatchTool({ name: 'sidekick_tail', args: { source: logPath, lines: 1 }, context: authorizedContext });
    assert.ok(text(result).includes('last'));
    result = await tools.dispatchTool({ name: 'tail', args: { source: logPath, lines: 1 }, context: authorizedContext });
    assert.ok(text(result).includes('last'));

    process.env.SIDEKICK_ALLOWED_PATHS = ROOT;
    result = await runAuthorized('tail', { source: path.join(TEST_DATA_DIR, 'outside.log') });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('Path blocked by policy'));

    result = await runAuthorized('tail', { source: path.join(ROOT, 'missing.log') });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'File not found: ' + path.join(ROOT, 'missing.log'));

    const deniedDirectory = path.join(ROOT, 'private');
    fs.mkdirSync(deniedDirectory);
    fs.writeFileSync(path.join(deniedDirectory, 'recent-private.txt'), 'private', 'utf8');
    process.env.SIDEKICK_REPOSITORY_ROOT = ROOT;
    process.env.SIDEKICK_MCP_DENIED_PATHS = deniedDirectory;
    try {
      result = await runAuthorized('timeline', { action: 'build', since: '1d', sources: ['files'] });
      assert.ok(text(result).includes('app.log'), 'timeline lists recent files that are in the allowed subtree');
      assert.ok(!text(result).includes('recent-private.txt'), 'timeline omits files under a nested denied subtree');
    } finally {
      delete process.env.SIDEKICK_REPOSITORY_ROOT;
      delete process.env.SIDEKICK_MCP_DENIED_PATHS;
      fs.rmSync(deniedDirectory, { recursive: true, force: true });
    }

    console.log('Monitoring Family Tests passed');
  } finally {
    delete process.env.SIDEKICK_ALLOWED_PATHS;
    delete process.env.SIDEKICK_DENIED_PATHS;
    delete process.env.SIDEKICK_MCP_ALLOWED_PATHS;
    db.clearToolLogs();
    db.closeDatabase();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('Monitoring Family Tests FAILED');
  console.error(error);
  process.exit(1);
});
