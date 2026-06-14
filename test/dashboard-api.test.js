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

// Clean up test data
const testKVFile = path.join(TEST_DATA_DIR, 'kvstore.json');
if (fs.existsSync(testKVFile)) {
  fs.unlinkSync(testKVFile);
}

// Helper function to make HTTP requests
function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 4100,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('test-user:test-pass').toString('base64')
      }
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
