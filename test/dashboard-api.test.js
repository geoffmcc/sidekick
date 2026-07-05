const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Set up test data directory
const TEST_DATA_DIR = path.join(__dirname, 'test-data-dashboard');
if (!fs.existsSync(TEST_DATA_DIR)) {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

// Set environment variables before requiring dashboard
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DASHBOARD_PORT = '4100';
process.env.SIDEKICK_DASHBOARD_USER = 'test-user';
process.env.SIDEKICK_DASHBOARD_PASS = 'test-pass';
process.env.SIDEKICK_API_KEY = 'test-sidekick-api-key';
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
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
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

// Wait for server to start
setTimeout(async () => {
  try {
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
      const response = await makeRequest('GET', '/api/tool-policy?name=sidekick_bash&source=agent&limit=1');
      assert.strictEqual(response.status, 200, 'Should return 200');
      assert.strictEqual(response.data.total, 1, 'Should inspect one source/tool decision');
      assert.strictEqual(response.data.sources[0], 'agent', 'Should honor source filter');
      assert.strictEqual(response.data.decisions[0].tool, 'sidekick_bash', 'Should honor tool filter');
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

      const deploymentResponse = await makeRequest('POST', '/api/quick-actions/deployment', {});
      assert.strictEqual(deploymentResponse.status, 200, 'Deployment action should return 200');
      assert.strictEqual(deploymentResponse.data.ok, true, 'Deployment action should be ok');
      assert.ok(deploymentResponse.data.result.branch, 'Deployment action should include branch');

      const unknownResponse = await makeRequest('POST', '/api/quick-actions/not-real', {});
      assert.strictEqual(unknownResponse.status, 404, 'Unknown quick action should return 404');
      console.log('Passed\n');
    }

    // Test 3.0g: metrics status reports safe setup state
    console.log('Test 3.0g: metrics status reports safe setup state');
    {
      const response = await makeRequest('GET', '/api/metrics/status');
      assert.strictEqual(response.status, 200, 'Metrics status should return 200');
      assert.ok(response.data.grafana, 'Should include Grafana status');
      assert.ok(response.data.influxdb, 'Should include InfluxDB status');
      assert.ok(response.data.collector, 'Should include collector status');
      assert.ok(Array.isArray(response.data.issues), 'Should include issues array');
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
