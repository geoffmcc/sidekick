const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Set up an isolated test data directory so repeated runs never reuse a
// partially migrated database from an earlier failed process.
const TEST_DATA_DIR = path.join(__dirname, 'test-data-dashboard');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

// Set environment variables before requiring dashboard
process.env.NODE_ENV = 'test';
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DASHBOARD_PORT = '4100';
process.env.SIDEKICK_DASHBOARD_USER = 'test-user';
process.env.SIDEKICK_DASHBOARD_PASS = 'test-pass';
// The test harness represents a deployment behind a trusted HTTPS proxy.
process.env.SIDEKICK_DASHBOARD_TRUST_PROXY = 'true';
process.env.SIDEKICK_API_KEY = 'test-sidekick-api-key';
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
const dbStore = require('../src/db');

// Helper function to make HTTP requests
function makeRequest(method, path, body = null, optionsOverride = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from('test-user:test-pass').toString('base64'),
      ...(optionsOverride.headers || {})
    };
    if (optionsOverride.auth === false) {
      delete headers.Authorization;
    }

    const options = {
      hostname: '127.0.0.1',
      port: 4100,
      path: path,
      method: method,
      headers
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

console.log('Running Dashboard API Tests...\n');

// Start dashboard server
delete require.cache[require.resolve('../src/dashboard')];
const dashboard = require('../src/dashboard');
const compute = require('../src/compute');

// Wait for server to start
setTimeout(async () => {
  try {
    console.log('Test 3.0a: dashboard summary exposes module health');
    {
      const response = await makeRequest('GET', '/api/dashboard-summary');
      assert.strictEqual(response.status, 200, 'Dashboard summary should succeed');
      assert.ok(response.data.health && response.data.health.modules, 'Dashboard summary should include module health');
      assert.ok(Array.isArray(response.data.health.modules.modules), 'Module health should include module rows');
      const dataUtilities = response.data.health.modules.modules.find(module => module.name === 'data-utilities');
      assert.ok(dataUtilities, 'Module health should include data-utilities');
      assert.ok(Array.isArray(dataUtilities.health_history), 'Dashboard module rows should include bounded health history');
      console.log('Passed\n');
    }

    console.log('Test 3.0aa: dashboard exposes bounded artifact custody metadata');
    {
      const unscoped = await makeRequest('GET', '/api/artifacts?limit=2');
      assert.strictEqual(unscoped.status, 400, 'Artifact metadata must reject an authenticated request without project scope');
      assert.strictEqual(unscoped.data.code, 'project_scope_required', 'Missing artifact scope should be machine-readable');
      const response = await makeRequest('GET', '/api/artifacts?project_id=dashboard-test&limit=2');
      assert.strictEqual(response.status, 200, 'Artifact dashboard API should succeed');
      assert.strictEqual(response.data.ok, true, 'Artifact dashboard API should report success');
      assert.ok(Array.isArray(response.data.artifacts), 'Artifact dashboard API should return rows');
      assert.ok(response.data.artifacts.length <= 2, 'Artifact dashboard API should enforce the requested bound');
      assert.ok(response.data.summary && Number.isInteger(response.data.summary.originals), 'Artifact dashboard API should return custody summary');
      console.log('Passed\n');
    }

    console.log('Test 3.0ab: dashboard exposes bounded event delivery state');
    {
      const response = await makeRequest('GET', '/api/event-deliveries?limit=2');
      assert.strictEqual(response.status, 200, 'Event delivery dashboard API should succeed');
      assert.strictEqual(response.data.ok, true, 'Event delivery dashboard API should report success');
      assert.ok(Array.isArray(response.data.subscriptions), 'Event delivery API should return subscriptions');
      assert.ok(Array.isArray(response.data.deliveries), 'Event delivery API should return deliveries');
      assert.ok(response.data.deliveries.length <= 2, 'Event delivery API should enforce the requested bound');
      assert.ok(response.data.stats && Number.isInteger(response.data.stats.dead_letter), 'Event delivery API should return status counts');
      console.log('Passed\n');
    }

    console.log('Test 3.0ac: dashboard exposes bounded connector lifecycle state');
    {
      const response = await makeRequest('GET', '/api/connectors?limit=2');
      assert.strictEqual(response.status, 200, 'Connector dashboard API should succeed');
      assert.strictEqual(response.data.ok, true, 'Connector dashboard API should report success');
      assert.ok(Array.isArray(response.data.connectors), 'Connector API should return connectors');
      assert.ok(response.data.connectors.length <= 2, 'Connector API should enforce the requested bound');
      assert.ok(response.data.summary && Number.isInteger(response.data.summary.healthy), 'Connector API should return lifecycle summary');
      console.log('Passed\n');
    }

    console.log('Test 3.0ad: authenticated connector operations enforce lifecycle and event safety');
    {
      const name = `dashboard-connector-${Date.now().toString(36)}`;
      const denied = await makeRequest('POST', '/api/connectors', { name, type: 'test' }, { auth: false });
      assert.strictEqual(denied.status, 401, 'Unauthenticated connector mutations should be rejected by dashboard auth');
      const rawCredential = await makeRequest('POST', '/api/connectors', { name: `${name}-raw`, type: 'test', config: { api_key: 'do-not-store' } });
      assert.strictEqual(rawCredential.status, 400, 'Connector API should reject raw credential configuration');
      const subscription = await makeRequest('POST', '/api/event-subscriptions', { name: `${name}-events`, event_type: 'connector.state_changed', max_attempts: 2 });
      assert.strictEqual(subscription.status, 200, 'Authenticated users should create event subscriptions');
      const created = await makeRequest('POST', '/api/connectors', { name, type: 'test', endpoint: 'https://example.test/api', secret_ref: 'secret:test/connector', config: { region: 'test' } });
      assert.strictEqual(created.status, 200, 'Authenticated users should register connectors');
      const connectorId = created.data.connector.connector_id;
      const configured = await makeRequest('POST', `/api/connectors/${connectorId}/configure`, { config: { region: 'test', timeout_ms: 2000 } });
      assert.strictEqual(configured.status, 200, 'Connector configuration should succeed');
      const enabled = await makeRequest('POST', `/api/connectors/${connectorId}/enable`, {});
      assert.strictEqual(enabled.status, 200, 'Connector enable should succeed');
      const health = await makeRequest('GET', `/api/connectors/${connectorId}/health`);
      assert.strictEqual(health.status, 502, 'Unsupported connector health should fail explicitly');
      assert.strictEqual(health.data.ok, false, 'Unsupported connector health should not report success');
      assert.strictEqual(health.data.probe_execution, 'adapter-owned', 'Dashboard health should not perform arbitrary network probes');
      const events = await makeRequest('GET', `/api/connectors/${connectorId}/events?limit=10`);
      assert.strictEqual(events.status, 200, 'Connector events should be reportable');
      assert.ok(events.data.events.some(event => event.event_type === 'connector.state_changed'), 'Connector lifecycle should emit events');
      const deliveries = await makeRequest('GET', `/api/event-deliveries?subscription_id=${subscription.data.subscription.subscription_id}&limit=10`);
      assert.strictEqual(deliveries.status, 200, 'Connector lifecycle events should enter delivery tracking');
      assert.ok(deliveries.data.deliveries.length >= 1, 'Connector lifecycle should enqueue subscribed events');
      const paused = await makeRequest('POST', `/api/event-subscriptions/${subscription.data.subscription.subscription_id}/pause`, {});
      assert.strictEqual(paused.status, 200, 'Authenticated users should pause event subscriptions');
      const resumed = await makeRequest('POST', `/api/event-subscriptions/${subscription.data.subscription.subscription_id}/resume`, {});
      assert.strictEqual(resumed.status, 200, 'Authenticated users should resume event subscriptions');
      const disabled = await makeRequest('POST', `/api/connectors/${connectorId}/disable`, {});
      assert.strictEqual(disabled.status, 200, 'Connector disable should succeed');
      console.log('Passed\n');
    }

    console.log('Test 3.0ae: scope snapshots and guard stay authenticated and digest-only');
    {
      const created = await makeRequest('POST', '/api/scope-snapshots', { project_id: 'dashboard-test', targets: [{ kind: 'host', value: 'example.test' }], rules: { allowed_operations: ['observe'] }, expires_at: new Date(Date.now() + 3600000).toISOString() });
      assert.strictEqual(created.status, 200, 'Authenticated users should create scope snapshots');
      const snapshot = created.data.snapshot;
      assert.ok(snapshot.digest && snapshot.targets[0].value_digest, 'Scope response should expose digests');
      assert.ok(!JSON.stringify(created.data).includes('example.test'), 'Scope response must not expose target values');
      const allowed = await makeRequest('POST', '/api/scope-guard/evaluate', { snapshot_id: snapshot.snapshot_id, project_id: 'dashboard-test', target_kind: 'host', target: 'example.test', operation: 'observe' });
      assert.strictEqual(allowed.status, 200, 'Scope evaluation should succeed');
      assert.strictEqual(allowed.data.decision.ok, true, 'In-scope dashboard evaluation should allow the operation');
      const denied = await makeRequest('POST', '/api/scope-guard/evaluate', { snapshot_id: snapshot.snapshot_id, project_id: 'dashboard-test', target_kind: 'host', target: 'outside.example.test', operation: 'observe' });
      assert.strictEqual(denied.status, 200, 'Scope denial should return a decision');
      assert.strictEqual(denied.data.decision.ok, false, 'Out-of-scope dashboard evaluation should deny');
      const listed = await makeRequest('GET', '/api/scope-snapshots?project_id=dashboard-test&limit=2');
      assert.strictEqual(listed.status, 200, 'Scope snapshots should be reportable');
      assert.ok(listed.data.snapshots.some(item => item.snapshot_id === snapshot.snapshot_id), 'Scope listing should include the snapshot');
      console.log('Passed\n');
    }

    // Test 3.0: dashboard shell and event streams require auth
    console.log('Test 3.0: dashboard shell and event streams require auth');
    {
      const rootResponse = await makeRequest('GET', '/', null, { auth: false });
      assert.strictEqual(rootResponse.status, 401, 'Root dashboard should require auth');

      const streamResponse = await makeRequest('GET', '/api/agent/stream/test-task', null, { auth: false });
      assert.strictEqual(streamResponse.status, 401, 'Agent stream should require auth');

      const staticResponse = await makeRequest('GET', '/static/fontawesome/css/all.min.css', null, { auth: false });
      assert.notStrictEqual(staticResponse.status, 401, 'Static assets should remain public');

      const staticTemplateResponse = await makeRequest('GET', '/static/dashboard.html', null, { auth: false });
      assert.strictEqual(staticTemplateResponse.status, 404, 'Dashboard HTML template should not be public static content');
      console.log('Passed\n');
    }

    console.log('Test 3.0aa2: HTTPS legacy login sessions set Secure cookies');
    {
      const response = await makeRequest('GET', '/', null, {
        headers: { 'X-Forwarded-Proto': 'https' }
      });
      assert.strictEqual(response.status, 200, 'Configured Basic Auth should succeed in the test harness');
      const cookies = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'].join(';') : String(response.headers['set-cookie'] || '');
      assert.match(cookies, /sidekick_sid=.*Secure/, 'HTTPS legacy sessions must set Secure cookies');
      console.log('Passed\n');
    }

    // Test 3.0b: mutating requests reject deceptive cross-origin hosts
    console.log('Test 3.0b: mutating requests reject deceptive cross-origin hosts');
    {
      const response = await makeRequest('PUT', '/api/kv/csrf-test', { value: 'blocked' }, {
        headers: {
          Origin: 'http://127.0.0.1:4100.evil.example',
          Host: '127.0.0.1:4100'
        }
      });
      assert.strictEqual(response.status, 403, 'Should reject non-matching Origin host');
      console.log('Passed\n');
    }

    console.log('Test 3.0b0: originless browser cross-site mutations are rejected');
    {
      const response = await makeRequest('PUT', '/api/kv/csrf-fetch-metadata-test', { value: 'blocked' }, {
        headers: {
          'Sec-Fetch-Site': 'cross-site',
          Host: '127.0.0.1:4100'
        }
      });
      assert.strictEqual(response.status, 403, 'Fetch Metadata must reject originless cross-site mutations');
      console.log('Passed\n');
    }

    console.log('Test 3.0b0a: authenticated session mutations require Origin');
    {
      const response = await makeRequest('PUT', '/api/kv/csrf-session-test', { value: 'blocked' }, {
        headers: {
          Cookie: 'sidekick_sid=valid-looking-session',
          Host: '127.0.0.1:4100'
        }
      });
      assert.strictEqual(response.status, 403, 'Session-authenticated originless mutations must be rejected');
      console.log('Passed\n');
    }

    console.log('Test 3.0b1: mutating requests reject same-host wrong-scheme origins');
    {
      const response = await makeRequest('PUT', '/api/kv/csrf-scheme-test', { value: 'blocked' }, {
        headers: {
          Origin: 'https://127.0.0.1:4100',
          Host: '127.0.0.1:4100'
        }
      });
      assert.strictEqual(response.status, 403, 'Should reject an HTTPS origin on an HTTP request');

      const forwardedResponse = await makeRequest('PUT', '/api/kv/csrf-scheme-test', { value: 'allowed' }, {
        headers: {
          Origin: 'https://127.0.0.1:4100',
          Host: '127.0.0.1:4100',
          'X-Forwarded-Proto': 'https'
        }
      });
      assert.notStrictEqual(forwardedResponse.status, 403, 'Should honor the effective HTTPS scheme behind a trusted proxy');
      console.log('Passed\n');
    }

    // Test 3.0b2: Grafana auth-proxy token rotation is explicit, not fake success
    console.log('Test 3.0b2: Grafana token rotation reports unsupported behavior');
    {
      const response = await makeRequest('POST', '/grafana/api/user/auth-tokens/rotate', {}, {
        headers: { Origin: 'http://127.0.0.1:4098', Host: '127.0.0.1:4098' }
      });
      assert.strictEqual(response.status, 501, 'Unsupported Grafana token rotation must not return success');
      assert.strictEqual(response.data.code, 'unsupported_operation', 'Unsupported operation should be machine-readable');
      console.log('Passed\n');
    }

    // Test 3.0c: dashboard database endpoints honor tool policy
    console.log('Test 3.0c: dashboard database endpoints honor tool policy');
    {
      const previousBlocked = process.env.SIDEKICK_DASHBOARD_BLOCKED_TOOLS;
      process.env.SIDEKICK_DASHBOARD_BLOCKED_TOOLS = 'sidekick_db_stats';
      const response = await makeRequest('GET', '/api/db/stats');
      assert.strictEqual(response.status, 403, 'Should block dashboard DB endpoint by policy');
      if (previousBlocked === undefined) delete process.env.SIDEKICK_DASHBOARD_BLOCKED_TOOLS;
      else process.env.SIDEKICK_DASHBOARD_BLOCKED_TOOLS = previousBlocked;
      console.log('Passed\n');
    }

    // Test 3.0c2: POST /api/db/query routes through the centralized dispatcher
    console.log('Test 3.0c2: POST /api/db/query routes through the dispatcher (mediated + audited)');
    {
      dbStore.clearToolLogs();
      const response = await makeRequest('POST', '/api/db/query', { sql: 'SELECT 1 AS one', readonly: true });
      assert.strictEqual(response.status, 200, 'query should return 200');
      assert.ok(response.data.ok, `query should succeed: ${JSON.stringify(response.data)}`);
      assert.ok(Array.isArray(response.data.rows), 'rows should be an array');
      assert.strictEqual(response.data.rows[0].one, 1, 'should return the SELECT 1 result');
      // The dispatcher (not a direct dbStore call) logs db_query to tool_logs
      // with source=dashboard; the pre-change direct route did not audit at all.
      const logs = dbStore.queryToolLogs({ tool: 'db_query', source: 'dashboard', limit: 10 });
      assert.ok(logs.length >= 1, 'db_query from the dashboard should be audited via the dispatcher');
      console.log('Passed\n');
    }

    // Test 3.0c3: a write query blocked by policy is denied through the dispatcher
    console.log('Test 3.0c3: dashboard db/query respects dispatcher policy denial');
    {
      const previousBlocked = process.env.SIDEKICK_DASHBOARD_BLOCKED_TOOLS;
      process.env.SIDEKICK_DASHBOARD_BLOCKED_TOOLS = 'sidekick_db_query';
      const response = await makeRequest('POST', '/api/db/query', { sql: 'SELECT 1', readonly: true });
      assert.strictEqual(response.status, 403, 'a policy-blocked db_query should be denied');
      if (previousBlocked === undefined) delete process.env.SIDEKICK_DASHBOARD_BLOCKED_TOOLS;
      else process.env.SIDEKICK_DASHBOARD_BLOCKED_TOOLS = previousBlocked;
      console.log('Passed\n');
    }

    // Test 3.0d: tool usage stats honor an explicit UTC day window
    console.log('Test 3.0d: tool usage stats honor an explicit UTC day window');
    {
      dbStore.clearToolLogs();
      const now = new Date();
      const utcStart = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0
      )).toISOString();
      const utcEnd = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0
      )).toISOString();
      const today = now.toISOString();
      const yesterday = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - 1,
        12,
        0,
        0,
        0
      )).toISOString();

      dbStore.appendToolLog({
        t: yesterday,
        n: 'sidekick_old_tool',
        a: 'value=old',
        d: 10,
        ok: true,
        s: 'yesterday log',
        src: 'mcp'
      });
      dbStore.appendToolLog({
        t: today,
        n: 'sidekick_today_tool',
        a: 'value=today',
        d: 20,
        ok: false,
        s: 'today log',
        src: 'mcp'
      });

      const response = await makeRequest('GET', `/api/stats?since=${encodeURIComponent(utcStart)}&until=${encodeURIComponent(utcEnd)}`);
      assert.strictEqual(response.status, 200, 'Should return 200');
      const toolStats = Object.fromEntries((response.data.stats || []).map(stat => [stat.name, stat]));
      assert.ok(!toolStats.sidekick_old_tool, 'Yesterday log should not be counted in today stats');
      assert.ok(toolStats.sidekick_today_tool, 'Today log should be counted');
      assert.strictEqual(toolStats.sidekick_today_tool.count, 1, 'Today count should be 1');
      assert.strictEqual(toolStats.sidekick_today_tool.ok, 0, 'Today success count should be 0');
      assert.strictEqual(toolStats.sidekick_today_tool.fail, 1, 'Today failure count should be 1');
      console.log('Passed\n');
    }

    // Test 3.0e: dashboard exposes summarized tool policy inspection
    console.log('Test 3.0e: dashboard exposes summarized tool policy inspection');
    {
      const response = await makeRequest('GET', '/api/tool-policy?name=bash&source=agent&limit=1');
      assert.strictEqual(response.status, 200, 'Should return 200');
      assert.strictEqual(response.data.total, 1, 'Should inspect one source/tool decision');
      assert.strictEqual(response.data.sources[0], 'agent', 'Should honor source filter');
      assert.strictEqual(response.data.decisions[0].tool, 'bash', 'Should honor tool filter');
      assert.ok(response.data.decisions[0].category, 'Should include category metadata');
      assert.ok(response.data.decisions[0].description, 'Should include description metadata');
      assert.ok(response.data.summary.sources.agent, 'Should include per-source policy summary');
      console.log('Passed\n');
    }

    // Test 3.0f: quick actions expose safe dashboard operations
    console.log('Test 3.0f: quick actions expose safe dashboard operations');
    {
      dbStore.clearToolLogs();
      dbStore.appendToolLog({
        t: new Date().toISOString(),
        n: 'sidekick_test_failure',
        a: 'value=test',
        d: 5,
        ok: false,
        s: 'quick action failure fixture',
        src: 'mcp'
      });

      const failuresResponse = await makeRequest('POST', '/api/quick-actions/recent-failures', {});
      assert.strictEqual(failuresResponse.status, 200, 'Recent failures action should return 200');
      assert.strictEqual(failuresResponse.data.ok, true, 'Recent failures action should be ok');
      assert.ok(failuresResponse.data.result.failures.some(f => f.tool === 'sidekick_test_failure'), 'Should include failure fixture');
      const failuresExecution = dbStore.getDb().prepare("SELECT * FROM platform_executions WHERE operation_type = 'dashboard_action' AND tool_action = 'recent-failures' ORDER BY updated_at DESC LIMIT 1").get();
      assert.ok(failuresExecution, 'Recent failures action should create a platform execution');
      assert.strictEqual(failuresExecution.tool_name, 'sidekick_dashboard', 'Dashboard execution should identify dashboard source');
      assert.strictEqual(failuresExecution.state, 'completed', 'Successful dashboard action should complete');

      const deploymentResponse = await makeRequest('POST', '/api/quick-actions/deployment', {});
      assert.strictEqual(deploymentResponse.status, 200, 'Deployment action should return 200');
      assert.strictEqual(deploymentResponse.data.ok, true, 'Deployment action should be ok');
      assert.ok(deploymentResponse.data.result.branch, 'Deployment action should include branch');

      const unknownResponse = await makeRequest('POST', '/api/quick-actions/not-real', {});
      assert.strictEqual(unknownResponse.status, 404, 'Unknown quick action should return 404');
      const unknownExecution = dbStore.getDb().prepare("SELECT * FROM platform_executions WHERE operation_type = 'dashboard_action' AND tool_action = 'not-real' ORDER BY updated_at DESC LIMIT 1").get();
      assert.ok(unknownExecution, 'Unknown quick action should still create a platform execution');
      assert.strictEqual(unknownExecution.state, 'failed', 'Unknown quick action should fail the platform execution');
      assert.strictEqual(unknownExecution.error_category, 'unknown_action', 'Unknown quick action should classify the error');
      console.log('Passed\n');
    }

    // Test 3.0g: dashboard compute API exposes overview, jobs, attempts, and artifacts
    console.log('Test 3.0g: dashboard compute API exposes overview, jobs, attempts, and artifacts');
    {
      compute.initialize();
      const job = compute.jobManager.createJob({ jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'dashboard compute' } });
      const attemptId = compute.jobManager.createAttempt(job.jobId, { workerId: 'wk_dashboard', leaseId: 'lease_dashboard' });
      compute.jobManager.updateAttempt(attemptId, { status: 'running' });
      compute.jobManager.createArtifact(job.jobId, { attemptId, workerId: 'wk_dashboard', leaseId: 'lease_dashboard', artifactType: 'result', name: 'result.txt', contentType: 'text/plain', contentHash: 'abc123', sizeBytes: 12, state: 'finalized' });

      const overview = await makeRequest('GET', '/api/compute');
      assert.strictEqual(overview.status, 200, 'Compute overview should return 200');
      assert.strictEqual(overview.data.ok, true, 'Compute overview should be ok');
      assert.ok(overview.data.overview.jobs.total >= 1, 'Compute overview should include job totals');

      const jobs = await makeRequest('GET', '/api/compute/jobs?limit=5');
      assert.strictEqual(jobs.status, 200, 'Compute jobs should return 200');
      assert.ok(jobs.data.jobs.some(j => j.jobId === job.jobId), 'Compute jobs should include fixture job');
      assert.ok(jobs.data.stats.attempts >= 1, 'Compute jobs should include attempt stats');
      assert.ok(jobs.data.stats.artifacts.finalized >= 1, 'Compute jobs should include artifact stats');

      const detail = await makeRequest('GET', '/api/compute/jobs/' + encodeURIComponent(job.jobId));
      assert.strictEqual(detail.status, 200, 'Compute job detail should return 200');
      assert.strictEqual(detail.data.job.jobId, job.jobId, 'Compute job detail should include job');
      assert.strictEqual(detail.data.attempts[0].attemptId, attemptId, 'Compute job detail should include attempts');
      assert.strictEqual(detail.data.artifacts[0].artifactType, 'result', 'Compute job detail should include artifacts');

      const workers = await makeRequest('GET', '/api/compute/workers');
      assert.strictEqual(workers.status, 200, 'Compute workers should return 200');
      assert.strictEqual(workers.data.ok, true, 'Compute workers should be ok');
      console.log('Passed\n');
    }

    // Test 3.0ga: compute overview names providers and executors
    // The dashboard labels the Compute tab metrics from these; bare counts left
    // the operator guessing what was being counted. Seed a healthy and an
    // unhealthy provider first, otherwise every array is empty and the
    // assertions below hold vacuously.
    console.log('Test 3.0ga: compute overview names providers and executors');
    {
      const suffix = Date.now().toString(36);
      const healthy = compute.providerRegistry.createProvider({
        providerType: 'mock', displayName: 'overview-healthy-' + suffix, endpoint: 'http://127.0.0.1:11434',
      });
      const sick = compute.providerRegistry.createProvider({
        providerType: 'mock', displayName: 'overview-unhealthy-' + suffix, endpoint: 'http://127.0.0.1:11435',
      });
      compute.providerRegistry.updateHealth(healthy.providerId, { status: 'healthy', success: true });
      compute.providerRegistry.updateHealth(sick.providerId, { status: 'unhealthy', success: false, error: 'seeded failure' });

      try {
        const res = await makeRequest('GET', '/api/compute');
        assert.strictEqual(res.status, 200, 'Compute overview should return 200');
        const ov = res.data.overview;

        assert.ok(ov.providers.total >= 2, 'Seeded providers should be counted');
        assert.ok(ov.providers.healthy >= 1, 'Seeded healthy provider should be counted');
        assert.strictEqual(ov.providers.names.length, ov.providers.total, 'Provider names should cover every configured provider');
        assert.strictEqual(ov.providers.healthyNames.length, ov.providers.healthy, 'Healthy names should match the healthy count');
        assert.strictEqual(
          ov.providers.unhealthyNames.length, ov.providers.total - ov.providers.healthy,
          'Unhealthy names should account for every provider that is not healthy'
        );
        assert.ok(ov.providers.names.includes(healthy.displayName), 'Names should include the healthy provider');
        assert.ok(ov.providers.names.includes(sick.displayName), 'Names should include the unhealthy provider');
        assert.ok(ov.providers.healthyNames.includes(healthy.displayName), 'Healthy names should include the healthy provider');
        assert.ok(!ov.providers.healthyNames.includes(sick.displayName), 'Healthy names should exclude the unhealthy provider');
        assert.ok(ov.providers.unhealthyNames.includes(sick.displayName), 'Unhealthy names should include the unhealthy provider');

        assert.strictEqual(typeof ov.executors, 'number', 'Executor count should stay a number for existing consumers');
        assert.ok(Array.isArray(ov.executorNames), 'Compute overview should name executors');
        assert.strictEqual(ov.executorNames.length, ov.executors, 'Executor names should match the executor count');
        assert.ok(ov.executorNames.every(n => typeof n === 'string' && n.length), 'Executor names should be non-empty strings');
      } finally {
        compute.providerRegistry.deleteProvider(healthy.providerId);
        compute.providerRegistry.deleteProvider(sick.providerId);
      }
      console.log('Passed\n');
    }

    // Test 3.0gb: dashboard compute API supports enrollment and admin controls
    console.log('Test 3.0gb: dashboard compute API supports enrollment and admin controls');
    {
      const suffix = Date.now().toString(36);
      const tokenResponse = await makeRequest('POST', '/api/compute/enrollment-tokens', { displayName: 'dashboard-worker-' + suffix, expiresInMs: 600000, maxConcurrentJobs: 1 });
      assert.strictEqual(tokenResponse.status, 200, 'Enrollment token endpoint should return 200');
      assert.ok(tokenResponse.data.token, 'Enrollment token should be returned once');
      const cmds = tokenResponse.data.install.commands;
      assert.ok(cmds.linux.includes(tokenResponse.data.token), 'Install command should include token');
      assert.ok(cmds.linux.includes('127.0.0.1:4097'), 'Install command should point at MCP port');
      assert.ok(cmds.windows.includes('/api') === false, 'Install command should point at server root');
      // The dashboard must advertise the platform SERVICE INSTALLERS (which
      // enroll + install the OS service + start it), not a bare enroll that
      // leaves nothing running. Guards against regressing to the old broken
      // `.exe enroll` / `enroll --service` commands.
      assert.ok(cmds.linux.includes('install-linux.sh'), 'Linux command runs the systemd service installer');
      assert.ok(cmds.macos.includes('install-macos.sh'), 'macOS command runs the launchd service installer');
      assert.ok(cmds.windows.includes('install-windows.ps1'), 'Windows command runs the winsw service installer');
      assert.ok(cmds.windows.includes('-EnrollToken ' + tokenResponse.data.token), 'Windows installer receives the token');
      assert.ok(!/\.exe enroll\b/.test(cmds.windows), 'Windows command must not call the winsw wrapper .exe with an enroll verb');
      assert.ok(!/\benroll --service\b/.test(cmds.linux + cmds.macos + cmds.windows), 'Platform commands must not be bare enroll-only');

      const enrolled = compute.workerManager.enrollWorker({
        nodeId: 'dashboard-node-' + suffix,
        displayName: 'dashboard-worker-' + suffix,
        platform: 'linux',
        architecture: 'x64',
        executors: [{ type: 'mock.inference', capabilities: ['chat'] }],
        enrollmentToken: tokenResponse.data.token,
        protocolVersion: '1'
      });
      const workerId = enrolled.worker.workerId;

      const listAfterEnroll = await makeRequest('GET', '/api/compute/workers');
      const listedWorker = (listAfterEnroll.data.workers || []).find(w => w.workerId === workerId);
      assert.ok(listedWorker, 'Enrolled worker appears in the list');
      for (const dim of ['connectionState', 'adminState', 'credentialState', 'healthState']) {
        assert.ok(dim in listedWorker, `Worker list should expose ${dim}`);
      }
      assert.strictEqual(listedWorker.credentialState, 'active', 'Freshly enrolled worker credential is active');

      const disabled = await makeRequest('POST', `/api/compute/workers/${workerId}/disable`, { reason: 'dashboard-test' });
      assert.strictEqual(disabled.status, 200, 'Worker disable should return 200');
      assert.strictEqual(disabled.data.worker.state, 'maintenance', 'Worker should enter maintenance');
      assert.strictEqual(disabled.data.worker.adminState, 'maintenance', 'Worker adminState should be maintenance');

      const enabled = await makeRequest('POST', `/api/compute/workers/${workerId}/enable`, { reason: 'dashboard-test' });
      assert.strictEqual(enabled.status, 200, 'Worker enable should return 200');
      assert.strictEqual(enabled.data.worker.maintenanceMode, false, 'Worker maintenance mode should clear');
      assert.strictEqual(enabled.data.worker.adminState, 'enabled', 'Worker adminState should be enabled');

      const job = compute.jobManager.createJob({ jobType: 'chat', capability: 'chat', requestPayload: { prompt: 'dashboard cancel retry' } });
      const cancelled = await makeRequest('POST', `/api/compute/jobs/${job.jobId}/cancel`, { reason: 'dashboard-test' });
      assert.strictEqual(cancelled.status, 200, 'Job cancel should return 200');
      assert.strictEqual(cancelled.data.job.status, 'cancelled', 'Job should be cancelled');

      const retried = await makeRequest('POST', `/api/compute/jobs/${job.jobId}/retry`, { reason: 'dashboard-test' });
      assert.strictEqual(retried.status, 200, 'Job retry should return 200');
      assert.strictEqual(retried.data.job.status, 'queued', 'Job should be queued after retry');

      const recovered = await makeRequest('POST', '/api/compute/recover', {});
      assert.strictEqual(recovered.status, 200, 'Recover endpoint should return 200');
      assert.ok(Number.isInteger(recovered.data.recovered), 'Recover should return recovered lease count');

      const revoked = await makeRequest('POST', `/api/compute/workers/${workerId}/revoke`, { reason: 'dashboard-test' });
      assert.strictEqual(revoked.status, 200, 'Worker revoke should return 200');
      assert.strictEqual(revoked.data.worker.state, 'revoked', 'Worker should be revoked');
      assert.strictEqual(revoked.data.worker.credentialState, 'revoked', 'Worker credentialState should be revoked');

      const reEnrollToken = await makeRequest('POST', '/api/compute/enrollment-tokens', { displayName: 'reenroll-' + suffix, expiresInMs: 600000, reEnrollmentOf: 'dashboard-node-' + suffix });
      assert.strictEqual(reEnrollToken.status, 200, 'Re-enrollment token endpoint should return 200');
      assert.strictEqual(reEnrollToken.data.reEnrollmentOf, 'dashboard-node-' + suffix, 'Token records the re-enrollment node');
      console.log('Passed\n');
    }

    // Test 3.0h: metrics status reports safe setup state
    console.log('Test 3.0h: metrics status reports safe setup state');
    {
      const response = await makeRequest('GET', '/api/metrics/status');
      assert.strictEqual(response.status, 200, 'Metrics status should return 200');
      assert.ok(response.data.grafana, 'Should include Grafana status');
      assert.ok(response.data.influxdb, 'Should include InfluxDB status');
      assert.ok(response.data.collector, 'Should include collector status');
      assert.ok(Array.isArray(response.data.issues), 'Should include issues array');
      console.log('Passed\n');
    }

    // Test 3.0h: activity API exposes sessions, raw call detail, metrics, and redaction
    console.log('Test 3.0h: activity API exposes session-oriented data');
    {
      dbStore.clearToolLogs();
      dbStore.appendToolLog({
        t: '2026-01-01T00:00:00.000Z',
        n: 'sidekick_alpha',
        a: 'project=alpha, token=sk-abcdefghijklmnopqrstuvwx',
        d: 20,
        ok: true,
        s: 'alpha ok',
        src: 'agent',
        taskId: 'task-1',
        project: 'alpha'
      });
      dbStore.appendToolLog({
        t: '2026-01-01T00:00:02.000Z',
        n: 'sidekick_beta',
        a: 'value=2',
        d: 40,
        ok: false,
        s: 'beta failed',
        src: 'agent',
        taskId: 'task-1',
        project: 'alpha'
      });
      dbStore.appendToolLog({
        t: '2026-01-01T00:10:00.000Z',
        n: 'sidekick_gamma',
        a: 'value=3',
        d: 10,
        ok: true,
        s: 'gamma ok',
        src: 'mcp'
      });
      dbStore.appendToolLog({
        t: '2026-01-01T00:20:00.000Z',
        n: 'sidekick_respond',
        a: 'text=generated',
        d: 12,
        ok: true,
        s: 'generated ok',
        src: 'dashboard',
        execution_id: 'gte-dashboard-activity',
        generated_procedure: 'sidekick_generated_observed_test',
        step_number: 1
      });

      const response = await makeRequest('GET', '/api/logs?limit=20');
      assert.strictEqual(response.status, 200, 'Should return 200');
      assert.ok(Array.isArray(response.data.sessions), 'Should include sessions');
      assert.ok(Array.isArray(response.data.entries), 'Should include raw entries');
      const taskSession = response.data.sessions.find(session => session.task_id === 'task-1');
      assert.ok(taskSession, 'Should group by real task id');
      assert.strictEqual(taskSession.grouping, 'task_id', 'Should identify real grouping method');
      assert.strictEqual(taskSession.call_count, 2, 'Task session should contain two calls');
      assert.strictEqual(taskSession.failure_count, 1, 'Task session should count failures');
      assert.ok(response.data.sessions.some(session => session.grouping === 'time_source_fallback'), 'Should expose deterministic fallback grouping');
      assert.strictEqual(response.data.summary.total_calls, 4, 'Should summarize total calls');
      assert.strictEqual(response.data.summary.failures, 1, 'Should summarize failures');
      assert.ok(response.data.entries.some(entry => entry.generated_activity && entry.execution_id === 'gte-dashboard-activity'), 'Should label generated-tool activity');
      assert.ok(!JSON.stringify(response.data).includes('sk-abcdefghijklmnopqrstuvwx'), 'Should redact sensitive values');
      console.log('Passed\n');
    }

    // Test 3.0ha: Black Box dashboard API exposes incidents, sources, analysis, and retention
    console.log('Test 3.0ha: Black Box dashboard API exposes incident evidence');
    {
      const capture = await makeRequest('POST', '/api/blackbox/capture', { name: 'dashboard blackbox fixture', include: ['system.identity'] });
      assert.strictEqual(capture.status, 200, 'Capture endpoint should return 200');
      assert.strictEqual(capture.data.ok, true, 'Capture endpoint should be ok');
      assert.ok(capture.data.capture.incident_id, 'Capture should return incident id');
      const incidentId = capture.data.capture.incident_id;
      const captureId = capture.data.capture.id;

      const incidents = await makeRequest('GET', '/api/blackbox/incidents?search=dashboard%20blackbox');
      assert.strictEqual(incidents.status, 200, 'Incident list should return 200');
      assert.ok(incidents.data.incidents.some(incident => incident.id === incidentId), 'Incident list should include fixture');

      const detail = await makeRequest('GET', `/api/blackbox/incidents/${incidentId}`);
      assert.strictEqual(detail.status, 200, 'Incident detail should return 200');
      assert.ok(detail.data.incident.timeline.length > 0, 'Incident detail should include timeline');

      const captureDetail = await makeRequest('GET', `/api/blackbox/captures/${captureId}`);
      assert.strictEqual(captureDetail.status, 200, 'Capture detail should return 200');
      assert.ok(captureDetail.data.capture.sources.length > 0, 'Capture detail should include source summaries');
      const sourceId = captureDetail.data.capture.sources[0].id;

      const source = await makeRequest('GET', `/api/blackbox/sources/${sourceId}`);
      assert.strictEqual(source.status, 200, 'Source detail should return 200');
      assert.ok(source.data.source.content_hash, 'Source detail should include content hash');

      const analysis = await makeRequest('POST', `/api/blackbox/incidents/${incidentId}/analyze`, {});
      assert.strictEqual(analysis.status, 200, 'Analysis endpoint should return 200');
      assert.ok(analysis.data.analysis.cited_source_ids.includes(sourceId), 'Analysis should cite source evidence');

      const pinned = await makeRequest('PATCH', `/api/blackbox/incidents/${incidentId}`, { pinned: true, retention_class: 'pinned' });
      assert.strictEqual(pinned.status, 200, 'Retention update should return 200');
      assert.strictEqual(pinned.data.incident.pinned, true, 'Incident should be pinned');

      const storage = await makeRequest('GET', '/api/blackbox/storage');
      assert.strictEqual(storage.status, 200, 'Storage endpoint should return 200');
      assert.ok(storage.data.incidents >= 1, 'Storage status should count incidents');
      console.log('Passed\n');
    }

    // Test 3.0i: activity API filters on real fields
    console.log('Test 3.0i: activity API filters on real fields');
    {
      const failures = await makeRequest('GET', '/api/logs?status=failure&source=agent&project=alpha&min_duration=30');
      assert.strictEqual(failures.status, 200, 'Should return 200');
      assert.strictEqual(failures.data.entries.length, 1, 'Should filter to one failed call');
      assert.strictEqual(failures.data.entries[0].tool, 'sidekick_beta', 'Should return matching tool');
      const execution = await makeRequest('GET', '/api/logs?session=gte-dashboard-activity');
      assert.strictEqual(execution.status, 200, 'Execution activity filter should return 200');
      assert.strictEqual(execution.data.entries.length, 1, 'Execution filter should return complete correlated execution');
      assert.strictEqual(execution.data.sessions[0].grouping, 'generated_execution', 'Execution activity should use generated execution grouping');
      console.log('Passed\n');
    }

    console.log('Test 3.0k: dashboard can run a generated trial tool and persist execution history');
    {
      dbStore.saveGeneratedCapability({
        id: 'cand_dashboard_run',
        name: 'sidekick_generated_dashboard_run',
        title: 'dashboard run',
        description: 'Dashboard generated run test',
        state: 'trial',
        evidence: [],
        evidenceCount: 1,
        successRate: 1,
        usefulnessScore: 0,
        parameters: { text: { type: 'string', required: true } },
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
        steps: [{ tool: 'sidekick_respond', args: { text: '{{text}}' } }, { tool: 'sidekick_respond', args: { text: 'done {{text}}' } }],
        risk: 'low',
        version: 1,
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        estimatedCallsSaved: 0,
        userFeedback: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      dbStore.syncGeneratedToolRegistry();
      const run = await makeRequest('POST', '/api/evolve/cand_dashboard_run/run', { args: { text: 'from dashboard' } });
      assert.strictEqual(run.status, 200, 'Run endpoint should return 200');
      assert.ok(run.data.execution_id, 'Run endpoint should return execution id');
      await new Promise(resolve => setTimeout(resolve, 120));
      const execution = dbStore.getGeneratedToolExecution(run.data.execution_id);
      assert.strictEqual(execution.state, 'succeeded', 'Dashboard execution should complete successfully');
      assert.strictEqual(execution.source, 'dashboard', 'Execution source should be dashboard');
      assert.strictEqual(execution.steps.length, 2, 'Execution should persist step history');
      assert.strictEqual(dbStore.syncGeneratedCapabilityStats('cand_dashboard_run').successCount, 1, 'Trial stats should count real execution');
      console.log('Passed\n');
    }

    // Test 3.0j: memory API separates durable and operational categories
    console.log('Test 3.0j: memory API separates durable and operational categories');
    {
      const db = dbStore.getDb();
      for (const migration of ['003_structured_memory.sql', '004_memory_lifecycle.sql', '005_sync_support.sql', '006_memory_deferred.sql']) {
        try {
          db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', migration), 'utf8'));
        } catch (error) {
          if (!/duplicate column name|already exists/i.test(error.message)) throw error;
        }
      }
      dbStore.upsertMemory({
        id: 'mem-dashboard-fact',
        type: 'fact',
        project: 'alpha',
        content: 'Alpha uses deterministic session grouping.',
        summary: 'Alpha session grouping fact',
        confidence: 0.9,
        source: 'test',
        automatic: false
      });
      dbStore.upsertMemory({
        id: 'mem-dashboard-tool',
        type: 'observation',
        project: 'alpha',
        content: 'sidekick_alpha observed a successful operation',
        summary: 'Operational observation',
        confidence: 0.5,
        source: 'agent',
        source_tool: 'sidekick_alpha',
        automatic: true
      });
      const response = await makeRequest('GET', '/api/memories?include_disabled=true&limit=500');
      assert.strictEqual(response.status, 200, 'Should return 200');
      const fact = response.data.memories.find(memory => memory.id === 'mem-dashboard-fact');
      const tool = response.data.memories.find(memory => memory.id === 'mem-dashboard-tool');
      assert.ok(fact, 'Should include durable memory');
      assert.ok(tool, 'Should include operational memory');
      assert.strictEqual(fact.category, 'durable', 'Facts should be durable');
      assert.strictEqual(tool.category, 'operational', 'Tool calls should be operational');
      assert.strictEqual(fact.importance, 'high', 'Importance should derive from confidence');
      assert.strictEqual(tool.source_tool, 'sidekick_alpha', 'Should expose source tool metadata');

      const disabled = await makeRequest('POST', '/api/memories/mem-dashboard-fact/disable');
      assert.strictEqual(disabled.status, 200, 'Disable should return 200');
      assert.strictEqual(disabled.data.ok, true, 'Disable should succeed');

      const enabled = await makeRequest('POST', '/api/memories/mem-dashboard-fact/enable');
      assert.strictEqual(enabled.status, 200, 'Enable should return 200');
      assert.strictEqual(enabled.data.ok, true, 'Enable should use the canonical lifecycle service');
      assert.strictEqual(dbStore.getMemoryById('mem-dashboard-fact').enabled, true, 'Enable should restore an operationally disabled memory');

      const deleted = await makeRequest('DELETE', '/api/memories/mem-dashboard-fact');
      assert.strictEqual(deleted.status, 200, 'Delete should return 200');
      assert.strictEqual(deleted.data.ok, true, 'Delete should soft-delete through the lifecycle service');
      const deletedMemory = dbStore.getMemoryById('mem-dashboard-fact');
      assert.strictEqual(deletedMemory.state, 'deleted', 'Dashboard delete should preserve the tombstone state');
      assert.strictEqual(deletedMemory.enabled, false, 'Deleted memories should not remain enabled');
      console.log('Passed\n');
    }

    // Test 3.1: GET /api/kv returns metadata
    console.log('Test 3.1: GET /api/kv returns metadata');
    {
      // Store some test data via API
      await makeRequest('PUT', '/api/kv/test-key', { 
        value: 'test-value', 
        project: 'testproj',
        source: 'mcp'
      });

      const response = await makeRequest('GET', '/api/kv');
      assert.strictEqual(response.status, 200, 'Should return 200');
      assert.ok(response.data.entries, 'Should have entries');
      assert.ok(response.data.entries.length > 0, 'Should have at least one entry');
      
      const entry = response.data.entries.find(e => e.key === 'test-key');
      assert.ok(entry, 'Should find test-key');
      assert.strictEqual(entry.value, 'test-value', 'Value should match');
      assert.strictEqual(entry.project, 'testproj', 'Project should match');
      assert.ok(entry.created, 'Should have created');
      assert.ok(entry.updated, 'Should have updated');
      assert.strictEqual(entry.data_type, 'string', 'Should include data type');
      assert.ok(Number.isFinite(entry.size), 'Should include size');
      assert.ok(entry.preview, 'Should include preview');
      assert.ok(response.data.summary.total_entries >= 1, 'Should include summary totals');
      console.log('✓ Passed\n');
    }

    // Test 3.2: PUT /api/kv/:key with project
    console.log('Test 3.2: PUT /api/kv/:key with project');
    {
      const response = await makeRequest('PUT', '/api/kv/newkey', { 
        value: 'newvalue', 
        project: 'newproj' 
      });
      assert.strictEqual(response.status, 200, 'Should return 200');
      assert.ok(response.data.ok, 'Should return ok');

      // Verify via API
      const getResponse = await makeRequest('GET', '/api/kv');
      const entry = getResponse.data.entries.find(e => e.key === 'newkey');
      assert.ok(entry, 'Should find newkey');
      assert.strictEqual(entry.value, 'newvalue', 'Value should match');
      assert.strictEqual(entry.project, 'newproj', 'Project should match');
      console.log('✓ Passed\n');
    }

    // Test 3.3: PUT /api/kv/:key without project preserves existing
    console.log('Test 3.3: PUT /api/kv/:key without project preserves existing');
    {
      // First create with project
      await makeRequest('PUT', '/api/kv/preserve-test', { 
        value: 'original', 
        project: 'original-proj' 
      });

      // Update without project
      await makeRequest('PUT', '/api/kv/preserve-test', { 
        value: 'updated'
      });

      // Verify via API
      const getResponse = await makeRequest('GET', '/api/kv');
      const entry = getResponse.data.entries.find(e => e.key === 'preserve-test');
      assert.ok(entry, 'Should find preserve-test');
      assert.strictEqual(entry.value, 'updated', 'Value should be updated');
      assert.strictEqual(entry.project, 'original-proj', 'Project should be preserved');
      console.log('✓ Passed\n');
    }

    // Test 3.4: GET /api/kv/projects
    console.log('Test 3.4: GET /api/kv/projects');
    {
      // Create keys with different projects
      await makeRequest('PUT', '/api/kv/proj1-key', { value: 'v1', project: 'proj1' });
      await makeRequest('PUT', '/api/kv/proj2-key', { value: 'v2', project: 'proj2' });
      await makeRequest('PUT', '/api/kv/global-key', { value: 'v3' }); // null project

      const response = await makeRequest('GET', '/api/kv/projects');
      assert.strictEqual(response.status, 200, 'Should return 200');
      assert.ok(Array.isArray(response.data.projects), 'Should return array');
      assert.ok(response.data.projects.includes('proj1'), 'Should include proj1');
      assert.ok(response.data.projects.includes('proj2'), 'Should include proj2');
      console.log('✓ Passed\n');
    }

    // Test 3.5: seedKV writes metadata
    console.log('Test 3.4a: GET /api/projects exposes canonical project registry');
    {
      const response = await makeRequest('GET', '/api/projects?limit=10');
      assert.strictEqual(response.status, 200, 'Project registry projection should return 200');
      assert.strictEqual(response.data.ok, true, 'Project registry projection should report success');
      assert.ok(Array.isArray(response.data.projects), 'Project registry projection should return rows');
      assert.ok(Number.isInteger(response.data.total), 'Project registry projection should return a bounded total');
      console.log('✓ Passed\n');
    }

    // Test 3.5: seedKV writes metadata
    console.log('Test 3.5: seedKV writes metadata');
    {
      // Delete existing test keys via API
      await makeRequest('DELETE', '/api/kv/test-key');
      await makeRequest('DELETE', '/api/kv/newkey');
      await makeRequest('DELETE', '/api/kv/preserve-test');
      await makeRequest('DELETE', '/api/kv/proj1-key');
      await makeRequest('DELETE', '/api/kv/proj2-key');
      await makeRequest('DELETE', '/api/kv/global-key');

      // Add a system key via API
      await makeRequest('PUT', '/api/kv/server:hostname', { 
        value: 'test-host', 
        project: 'system',
        source: 'dashboard'
      });

      const response = await makeRequest('GET', '/api/kv');
      const entry = response.data.entries.find(e => e.key === 'server:hostname');
      assert.ok(entry, 'Should find server:hostname');
      assert.strictEqual(entry.project, 'system', 'System keys should have system project');
      console.log('✓ Passed\n');
    }

    // Test 3.6: DELETE /api/kv/:key
    console.log('Test 3.6: DELETE /api/kv/:key');
    {
      // Create a key to delete
      await makeRequest('PUT', '/api/kv/to-delete', { value: 'delete-me' });

      // Delete it
      const deleteResponse = await makeRequest('DELETE', '/api/kv/to-delete');
      assert.strictEqual(deleteResponse.status, 200, 'Should return 200');
      assert.ok(deleteResponse.data.ok, 'Should return ok');

      // Verify it's gone via API
      const getResponse = await makeRequest('GET', '/api/kv');
      const deletedEntry = getResponse.data.entries.find(e => e.key === 'to-delete');
      assert.ok(!deletedEntry, 'Key should be deleted');
      console.log('✓ Passed\n');
    }

    // Test 3.7: Removed - backward compatibility test not applicable with SQLite backend
    // The SQLite schema enforces structure, so there's no "old format" to migrate from

    // Clean up
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    
    console.log('All Dashboard API Tests Passed! ✓');
    process.exit(0);
  } catch (e) {
    console.error('Test failed:', e);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  }
}, 1000);
