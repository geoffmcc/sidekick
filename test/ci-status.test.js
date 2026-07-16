const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const https = require('https');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-ci-status-'));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.GITHUB_TOKEN = 'ghp_test_token_secret';
process.on('exit', () => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

delete require.cache[require.resolve('../src/tools')];
const { TOOLS, TOOL_DEFS, getToolRisk } = require('../src/tools');
const { ci_status } = TOOLS;

function installGithubMock(routes) {
  const original = https.request;
  const calls = [];

  https.request = (options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      const key = `${options.method} ${options.path}`;
      calls.push({ key, options });
      const route = routes[key];
      if (!route) {
        process.nextTick(() => req.emit('error', new Error(`Unexpected request: ${key}`)));
        return;
      }
      if (route.error) {
        process.nextTick(() => req.emit('error', new Error(route.error)));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = route.status || 200;
      res.headers = route.headers || {};
      process.nextTick(() => {
        callback(res);
        const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body || {});
        if (body) res.emit('data', body);
        res.emit('end');
      });
    };
    return req;
  };

  return {
    calls,
    restore() {
      https.request = original;
    }
  };
}

async function withMock(routes, fn) {
  const mock = installGithubMock(routes);
  try {
    return await fn(mock);
  } finally {
    mock.restore();
  }
}

function checksBody(check_runs) {
  return { total_count: check_runs.length, check_runs };
}

function statusesBody(statuses, sha = 'abc123') {
  return { state: 'success', sha, total_count: statuses.length, statuses };
}

function baseRoutes(ref, checkRuns, statuses) {
  return {
    [`GET /repos/geoffmcc/sidekick/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`]: { body: checksBody(checkRuns) },
    [`GET /repos/geoffmcc/sidekick/commits/${encodeURIComponent(ref)}/status?per_page=100`]: { body: statusesBody(statuses, ref) }
  };
}

async function getJson(args, routes) {
  return withMock(routes, async () => {
    const result = await ci_status({ repo: 'geoffmcc/sidekick', format: 'json', ...args });
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  });
}

console.log('Running CI Status Tests...\n');

(async () => {
  try {
    console.log('Test 1: PR number resolves to head.sha');
    await withMock({
      'GET /repos/geoffmcc/sidekick/pulls/12': { body: { head: { sha: 'headsha123' } } },
      ...baseRoutes('headsha123', [{ name: 'test', status: 'completed', conclusion: 'success' }], [])
    }, async (mock) => {
      const result = await ci_status({ repo: 'geoffmcc/sidekick', pr: 12, format: 'json' });
      assert.ok(!result.isError, result.content[0].text);
      const data = JSON.parse(result.content[0].text);
      assert.strictEqual(data.sha, 'headsha123');
      assert.deepStrictEqual(data.requested, { type: 'pr', value: 12 });
      assert.ok(mock.calls.some(call => call.key.includes('/pulls/12')));
    });

    console.log('Test 2: all checks successful');
    let data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [
      { name: 'test (22.x)', status: 'completed', conclusion: 'success' },
      { name: 'test (24.x)', status: 'completed', conclusion: 'success' }
    ], []));
    assert.strictEqual(data.overall, 'success');
    assert.strictEqual(data.summary.passed, 2);

    console.log('Test 3: one failed check');
    data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'failure' }
    ], []));
    assert.strictEqual(data.overall, 'failure');
    assert.strictEqual(data.summary.failed, 1);

    console.log('Test 4: queued check');
    data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [{ name: 'queued', status: 'queued', conclusion: null }], []));
    assert.strictEqual(data.overall, 'pending');
    assert.strictEqual(data.summary.pending, 1);

    console.log('Test 5: in-progress check');
    data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [{ name: 'build', status: 'in_progress', conclusion: null }], []));
    assert.strictEqual(data.overall, 'pending');

    console.log('Test 6: cancelled check');
    data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [{ name: 'build', status: 'completed', conclusion: 'cancelled' }], []));
    assert.strictEqual(data.overall, 'failure');

    console.log('Test 7: timed-out check');
    data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [{ name: 'build', status: 'completed', conclusion: 'timed_out' }], []));
    assert.strictEqual(data.overall, 'failure');

    console.log('Test 8: skipped and neutral checks');
    data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [
      { name: 'optional', status: 'completed', conclusion: 'neutral' },
      { name: 'docs', status: 'completed', conclusion: 'skipped' }
    ], []));
    assert.strictEqual(data.overall, 'success');
    assert.strictEqual(data.summary.passed, 1);
    assert.strictEqual(data.summary.skipped, 1);

    console.log('Test 9: legacy statuses combine with check runs');
    data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [
      { name: 'test', status: 'completed', conclusion: 'success' }
    ], [
      { context: 'coverage', state: 'pending', target_url: 'https://example.invalid/coverage' }
    ]));
    assert.strictEqual(data.overall, 'pending');
    assert.strictEqual(data.summary.total, 2);

    console.log('Test 10: no checks or statuses');
    data = await getJson({ sha: 'abc123' }, baseRoutes('abc123', [], []));
    assert.strictEqual(data.overall, 'no_checks');
    assert.strictEqual(data.summary.total, 0);

    console.log('Test 11: pagination');
    await withMock({
      'GET /repos/geoffmcc/sidekick/commits/abc123/check-runs?per_page=100': {
        headers: { link: '<https://api.github.com/repos/geoffmcc/sidekick/commits/abc123/check-runs?per_page=100&page=2>; rel="next"' },
        body: checksBody([{ name: 'page1', status: 'completed', conclusion: 'success' }])
      },
      'GET /repos/geoffmcc/sidekick/commits/abc123/check-runs?per_page=100&page=2': {
        body: checksBody([{ name: 'page2', status: 'completed', conclusion: 'success' }])
      },
      'GET /repos/geoffmcc/sidekick/commits/abc123/status?per_page=100': {
        headers: { link: '<https://api.github.com/repos/geoffmcc/sidekick/commits/abc123/status?per_page=100&page=2>; rel="next"' },
        body: statusesBody([{ context: 'legacy1', state: 'success' }])
      },
      'GET /repos/geoffmcc/sidekick/commits/abc123/status?per_page=100&page=2': {
        body: statusesBody([{ context: 'legacy2', state: 'success' }])
      }
    }, async () => {
      const result = await ci_status({ repo: 'geoffmcc/sidekick', sha: 'abc123', format: 'json' });
      const pageData = JSON.parse(result.content[0].text);
      assert.strictEqual(pageData.summary.total, 4);
      assert.strictEqual(pageData.check_runs.length, 2);
      assert.strictEqual(pageData.statuses.length, 2);
    });

    console.log('Test 12: invalid repository');
    let result = await ci_status({ repo: 'badrepo', sha: 'abc123' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Invalid repository'));

    console.log('Test 13: missing revision selector');
    result = await ci_status({ repo: 'geoffmcc/sidekick' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Exactly one revision selector'));

    console.log('Test 14: conflicting selectors');
    result = await ci_status({ repo: 'geoffmcc/sidekick', pr: 1, sha: 'abc123' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Conflicting revision selectors'));

    console.log('Test 15: GitHub authentication failure');
    await withMock({
      'GET /repos/geoffmcc/sidekick/commits/abc123/check-runs?per_page=100': { status: 401, body: { message: 'Bad credentials' } }
    }, async () => {
      const authResult = await ci_status({ repo: 'geoffmcc/sidekick', sha: 'abc123' });
      assert.ok(authResult.isError);
      assert.ok(authResult.content[0].text.includes('Bad credentials'));
    });

    console.log('Test 16: GitHub rate-limit response');
    await withMock({
      'GET /repos/geoffmcc/sidekick/commits/abc123/check-runs?per_page=100': { status: 403, body: { message: 'API rate limit exceeded' } }
    }, async () => {
      const rateResult = await ci_status({ repo: 'geoffmcc/sidekick', sha: 'abc123' });
      assert.ok(rateResult.isError);
      assert.ok(rateResult.content[0].text.includes('rate limit'));
    });

    console.log('Test 17: JSON output schema');
    data = await getJson({ ref: 'main' }, baseRoutes('main', [{ name: 'test', head_sha: 'resolvedmainsha', status: 'completed', conclusion: 'success', details_url: 'https://example.invalid/run' }], []));
    assert.strictEqual(data.repo, 'geoffmcc/sidekick');
    assert.deepStrictEqual(data.requested, { type: 'ref', value: 'main' });
    assert.strictEqual(data.sha, 'resolvedmainsha');
    assert.ok(data.summary);
    assert.ok(Array.isArray(data.check_runs));
    assert.ok(Array.isArray(data.statuses));

    console.log('Test 18: token redaction from errors');
    await withMock({
      'GET /repos/geoffmcc/sidekick/commits/abc123/check-runs?per_page=100': { status: 500, body: { message: `token ${process.env.GITHUB_TOKEN} leaked` } }
    }, async () => {
      const redacted = await ci_status({ repo: 'geoffmcc/sidekick', sha: 'abc123' });
      assert.ok(redacted.isError);
      assert.ok(!redacted.content[0].text.includes(process.env.GITHUB_TOKEN));
    });

    console.log('Test 19: tool registration and low risk');
    assert.ok(TOOL_DEFS.some(def => def.name === 'ci_status'));
    assert.strictEqual(getToolRisk('ci_status'), 'low');

    console.log('\n✓ CI Status Tests Passed');
  } catch (err) {
    console.error('\nCI Status Tests Failed:');
    console.error(err);
    process.exit(1);
  }
})();
