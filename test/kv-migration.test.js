const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Mock the KV file for testing
const TEST_KV_FILE = path.join(__dirname, 'test-kvstore.json');

// Clean up before tests
if (fs.existsSync(TEST_KV_FILE)) {
  fs.unlinkSync(TEST_KV_FILE);
}

// Import after setting up test file
const { migrateKV } = require('../src/tools');

console.log('Running KV Migration Tests...\n');

// Test 1.1: Migrate flat string values
console.log('Test 1.1: Migrate flat string values');
{
  const input = { "test-key": "hello from opencode" };
  const result = migrateKV(input);
  
  assert.strictEqual(typeof result["test-key"], 'object', 'Should convert to object');
  assert.strictEqual(result["test-key"].value, "hello from opencode", 'Value should be preserved');
  assert.strictEqual(result["test-key"].project, null, 'Project should be null');
  assert.strictEqual(result["test-key"].source, "init", 'Source should be init');
  assert.ok(result["test-key"].created, 'Should have created timestamp');
  assert.ok(result["test-key"].updated, 'Should have updated timestamp');
  console.log('✓ Passed\n');
}

// Test 1.2: Migrate with pattern matching
console.log('Test 1.2: Migrate with pattern matching');
{
  const input = { 
    "server:hostname": "sidekick-1", 
    "proxmox_backup_plan": "migration plan data",
    "env_var_deployment_status": "deployment data"
  };
  const result = migrateKV(input);
  
  assert.strictEqual(result["server:hostname"].project, "system", 'server:* should map to system');
  assert.strictEqual(result["proxmox_backup_plan"].project, "proxmox_backup", 'proxmox_backup_* should map to proxmox_backup');
  assert.strictEqual(result["env_var_deployment_status"].project, "proxmox_backup", 'env_var_deployment_status should map to proxmox_backup');
  console.log('✓ Passed\n');
}

// Test 1.3: Idempotent migration
console.log('Test 1.3: Idempotent migration');
{
  const now = new Date().toISOString();
  const input = { 
    "test-key": { 
      value: "already migrated", 
      project: "myproject", 
      source: "mcp",
      created: now, 
      updated: now 
    } 
  };
  const result = migrateKV(input);
  
  assert.deepStrictEqual(result["test-key"], input["test-key"], 'Should not modify already migrated data');
  console.log('✓ Passed\n');
}

// Test 1.4: Mixed format
console.log('Test 1.4: Mixed format');
{
  const now = new Date().toISOString();
  const input = { 
    "flat-key": "flat value",
    "migrated-key": { 
      value: "already migrated", 
      project: "proj", 
      source: "mcp",
      created: now, 
      updated: now 
    }
  };
  const result = migrateKV(input);
  
  assert.strictEqual(typeof result["flat-key"], 'object', 'Flat key should be migrated');
  assert.strictEqual(result["flat-key"].value, "flat value", 'Flat key value preserved');
  assert.deepStrictEqual(result["migrated-key"], input["migrated-key"], 'Migrated key should be unchanged');
  console.log('✓ Passed\n');
}

// Test 1.5: Pattern matching for all system prefixes
console.log('Test 1.5: Pattern matching for all system prefixes');
{
  const input = {
    "server:test": "value",
    "network:test": "value",
    "services:test": "value",
    "security:test": "value",
    "software:test": "value",
    "deploy:test": "value",
    "config:test": "value"
  };
  const result = migrateKV(input);
  
  Object.keys(input).forEach(key => {
    assert.strictEqual(result[key].project, "system", `${key} should map to system`);
  });
  console.log('✓ Passed\n');
}

// Test 1.6: Project naming validation
console.log('Test 1.6: Project naming validation');
{
  const validProjects = ["myproject", "my_project", "project123", "a"];
  const invalidProjects = ["MyProject", "my-project", "123project", "my project", ""];
  
  validProjects.forEach(proj => {
    assert.ok(/^[a-z][a-z0-9_]*$/.test(proj), `${proj} should be valid`);
  });
  
  invalidProjects.forEach(proj => {
    assert.ok(!/^[a-z][a-z0-9_]*$/.test(proj), `${proj} should be invalid`);
  });
  console.log('✓ Passed\n');
}

// Clean up
if (fs.existsSync(TEST_KV_FILE)) {
  fs.unlinkSync(TEST_KV_FILE);
}

console.log('All KV Migration Tests Passed! ✓');
