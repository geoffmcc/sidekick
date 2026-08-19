#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DATA_DIR = path.join(__dirname, 'test-data');
if (!fs.existsSync(TEST_DATA_DIR)) fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

const dispatcher = require('../src/tools/dispatcher');
const bashHandler = dispatcher.getBuiltinRegistry().get('bash').handler;
assert.ok(bashHandler, 'bash tool handler should be registered');

console.log('Running Bash Tool Tests...\n');

const nodeExecutable = process.platform === 'win32' ? `"${process.execPath}"` : process.execPath;

(async () => {
  try {
    console.log('Test 1: returns stdout on success');
    const ok = await bashHandler({ command: `${nodeExecutable} -e "process.stdout.write('hello-from-bash')"` });
    assert.strictEqual(ok.isError, undefined, 'should not be an error');
    assert.ok(ok.content[0].text.includes('hello-from-bash'), 'stdout should be returned');
    console.log('✓ Passed\n');

    console.log('Test 2: reports non-zero exit code with output');
    const err = await bashHandler({ command: `${nodeExecutable} -e "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"` });
    assert.strictEqual(err.isError, true, 'should be an error');
    assert.ok(err.content[0].text.includes('Exit code: 7'), 'should report exit code');
    assert.ok(err.content[0].text.includes('out'), 'should include stdout');
    assert.ok(err.content[0].text.includes('err'), 'should include stderr');
    console.log('✓ Passed\n');

    console.log('Test 3: blocks dangerous patterns');
    const blocked = await bashHandler({ command: 'rm -rf /' });
    assert.strictEqual(blocked.isError, true, 'should be blocked');
    assert.ok(blocked.content[0].text.includes('Blocked'), 'should report blocked');
    console.log('✓ Passed\n');

    console.log('Test 4: event loop stays free during command execution');
    const server = http.createServer((req, res) => res.end('pong'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const started = Date.now();
      const result = await bashHandler({
        command: `${nodeExecutable} -e "require('http').get('http://127.0.0.1:${port}/ping', r => { let b=''; r.on('data', c => b += c); r.on('end', () => console.log(b)); })"`,
      });
      const elapsed = Date.now() - started;
      assert.ok(!result.isError, `expected success, got: ${result.content[0].text}`);
      assert.ok(result.content[0].text.includes('pong'), `expected pong, got: ${result.content[0].text}`);
      assert.ok(elapsed < 5000, `round-trip should be fast, took ${elapsed}ms`);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    console.log('✓ Passed\n');

    console.log('All Bash Tool tests passed.');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
