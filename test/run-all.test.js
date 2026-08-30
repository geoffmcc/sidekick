const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require('./run-all');

const root = path.join(__dirname, '..');

function silentOutput() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

const actual = fs.readdirSync(__dirname).filter((file) => /\.test\.(?:js|cjs)$/.test(file));
const discovered = runner.discoverSuites().map((suite) => path.basename(suite.file));
assert.deepStrictEqual(new Set(discovered), new Set(actual), 'every current test suite must be discoverable');
assert.ok(discovered.includes('run-all.test.js'), 'runner regression tests must be included by discovery');
console.log('  passed: discovery includes every current .test.js/.test.cjs file');

const unknown = runner.selectSuites(discovered.map((file) => ({ file: `test/${file}` })), ['missing.test.js']);
assert.notStrictEqual(unknown.error, null, 'unknown selections must be rejected');
assert.deepStrictEqual(runner.selectSuites([], []).selected, [], 'empty discovery must select no suites');
assert.notStrictEqual(runner.runSuites({ allSuites: [], output: silentOutput() }).exitCode, 0, 'empty selections must fail nonzero');
console.log('  passed: unknown and empty selections fail closed');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-runner-'));
fs.mkdirSync(path.join(temporary, 'test'));
for (const file of ['skip.test.js', 'pass.test.js', 'after.test.js']) {
  fs.writeFileSync(path.join(temporary, 'test', file), '');
}
try {
  const output = silentOutput();
  const statuses = [runner.SKIP_EXIT_CODE, 0];
  const result = runner.runSuites({
    cwd: temporary,
    allSuites: [
      { file: 'test/skip.test.js', critical: false, description: 'skip fixture' },
      { file: 'test/pass.test.js', critical: false, description: 'pass fixture' },
    ],
    spawnSyncImpl: () => ({ status: statuses.shift() }),
    output,
  });
  assert.deepStrictEqual({ passed: result.passed, skipped: result.skipped, failed: result.failed }, { passed: 1, skipped: 1, failed: 0 });
  console.log('  passed: reserved skip exit is not counted as a pass');

  const stopOutput = silentOutput();
  const stopped = runner.runSuites({
    cwd: temporary,
    allSuites: [
      { file: 'test/critical.test.js', critical: true, description: 'critical fixture' },
      { file: 'test/after.test.js', critical: false, description: 'after fixture' },
    ],
    spawnSyncImpl: () => ({ status: 1 }),
    output: stopOutput,
  });
  assert.deepStrictEqual(stopped.notRun, ['test/after.test.js']);
  assert.ok(stopOutput.lines.includes('  - test/after.test.js'), 'not-run suites must be reported');
  console.log('  passed: critical failure reports suites not run');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('run-all runner tests passed.');
