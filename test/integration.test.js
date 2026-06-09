const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Set up test data directory
const TEST_DATA_DIR = path.join(__dirname, 'test-data-integration');
if (!fs.existsSync(TEST_DATA_DIR)) {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

// Set environment variable before requiring modules
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

// Clean up test data
const testKVFile = path.join(TEST_DATA_DIR, 'kvstore.json');
if (fs.existsSync(testKVFile)) {
  fs.unlinkSync(testKVFile);
}

console.log('Running Integration Tests...\n');

// Test 4.1: Full workflow - store, list projects, get by project
console.log('Test 4.1: Full workflow - store, list projects, get by project');
(async () => {
  try {
    // Clear require cache and import fresh
    delete require.cache[require.resolve('../src/tools')];
    const tools = require('../src/tools');
    const { 
      TOOLS,
      setSource 
    } = tools;
    const { sidekick_store, sidekick_get, sidekick_list_projects, sidekick_get_by_project } = TOOLS;

    setSource('mcp');

    // Store 5 keys across 3 projects
    await sidekick_store({ key: 'key1', value: 'val1', project: 'proj_a' });
    await sidekick_store({ key: 'key2', value: 'val2', project: 'proj_a' });
    await sidekick_store({ key: 'key3', value: 'val3', project: 'proj_b' });
    await sidekick_store({ key: 'key4', value: 'val4', project: 'proj_c' });
    await sidekick_store({ key: 'key5', value: 'val5' }); // null project

    // List projects
    const projectsResult = await sidekick_list_projects();
    const projects = JSON.parse(projectsResult.content[0].text);
    assert.ok(projects.includes('proj_a'), 'Should include proj_a');
    assert.ok(projects.includes('proj_b'), 'Should include proj_b');
    assert.ok(projects.includes('proj_c'), 'Should include proj_c');
    assert.ok(projects.includes(null), 'Should include null project');
    console.log('✓ Projects listed correctly');

    // Get by project
    const projAResult = await sidekick_get_by_project({ project: 'proj_a' });
    const projAKeys = JSON.parse(projAResult.content[0].text);
    assert.strictEqual(projAKeys.length, 2, 'proj_a should have 2 keys');
    assert.ok(projAKeys.find(k => k.key === 'key1'), 'Should find key1');
    assert.ok(projAKeys.find(k => k.key === 'key2'), 'Should find key2');
    console.log('✓ Get by project works');

    // Get individual key (backward compatibility)
    const getResult = await sidekick_get({ key: 'key1' });
    assert.strictEqual(getResult.content[0].text, 'val1', 'Should return just value');
    console.log('✓ Backward compatibility maintained');

    console.log('✓ Test 4.1 Passed\n');

    // Test 4.2: Migration + new tools
    console.log('Test 4.2: Migration + new tools');
    {
      // Clear KV and write flat data
      const flatData = {
        "server:hostname": "test-host",
        "network:ip": "192.168.1.1",
        "proxmox_backup_plan": "backup plan data",
        "custom_key": "custom value"
      };
      fs.writeFileSync(testKVFile, JSON.stringify(flatData, null, 2));

      // Clear require cache and re-import to trigger migration
      delete require.cache[require.resolve('../src/tools')];
      const tools2 = require('../src/tools');
      
      // Wait for migration to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // List projects - should have system, proxmox_backup, and null
      const projectsResult2 = await tools2.TOOLS.sidekick_list_projects();
      const projects2 = JSON.parse(projectsResult2.content[0].text);
      assert.ok(projects2.includes('system'), 'Should have system project');
      assert.ok(projects2.includes('proxmox_backup'), 'Should have proxmox_backup project');
      assert.ok(projects2.includes(null), 'Should have null project');
      console.log('✓ Migration created correct projects');

      // Get by system project
      const systemResult = await tools2.TOOLS.sidekick_get_by_project({ project: 'system' });
      const systemKeys = JSON.parse(systemResult.content[0].text);
      assert.ok(systemKeys.length >= 2, 'System should have at least 2 keys');
      assert.ok(systemKeys.find(k => k.key === 'server:hostname'), 'Should find server:hostname');
      assert.ok(systemKeys.find(k => k.key === 'network:ip'), 'Should find network:ip');
      console.log('✓ System project keys correct');

      // Get by proxmox_backup project
      const proxmoxResult = await tools2.TOOLS.sidekick_get_by_project({ project: 'proxmox_backup' });
      const proxmoxKeys = JSON.parse(proxmoxResult.content[0].text);
      assert.strictEqual(proxmoxKeys.length, 1, 'proxmox_backup should have 1 key');
      assert.strictEqual(proxmoxKeys[0].key, 'proxmox_backup_plan', 'Should be proxmox_backup_plan');
      console.log('✓ Proxmox_backup project keys correct');

      // Get by null project
      const nullResult = await tools2.TOOLS.sidekick_get_by_project({ project: null });
      const nullKeys = JSON.parse(nullResult.content[0].text);
      assert.ok(nullKeys.find(k => k.key === 'custom_key'), 'Should find custom_key in null project');
      console.log('✓ Null project keys correct');

      console.log('✓ Test 4.2 Passed\n');
    }

    // Test 4.3: Concurrent operations
    console.log('Test 4.3: Concurrent operations');
    {
      // Clear KV
      fs.writeFileSync(testKVFile, '{}');
      
      delete require.cache[require.resolve('../src/tools')];
      const tools3 = require('../src/tools');

      // Perform multiple concurrent stores
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(tools3.TOOLS.sidekick_store({ 
          key: `concurrent_${i}`, 
          value: `value_${i}`, 
          project: i % 2 === 0 ? 'even' : 'odd' 
        }));
      }
      await Promise.all(promises);

      // Verify all were stored
      const kvData = JSON.parse(fs.readFileSync(testKVFile, 'utf-8'));
      assert.strictEqual(Object.keys(kvData).length, 10, 'Should have 10 keys');
      
      // Verify projects
      const evenResult = await tools3.TOOLS.sidekick_get_by_project({ project: 'even' });
      const evenKeys = JSON.parse(evenResult.content[0].text);
      assert.strictEqual(evenKeys.length, 5, 'Should have 5 even keys');
      
      const oddResult = await tools3.TOOLS.sidekick_get_by_project({ project: 'odd' });
      const oddKeys = JSON.parse(oddResult.content[0].text);
      assert.strictEqual(oddKeys.length, 5, 'Should have 5 odd keys');
      
      console.log('✓ Concurrent operations handled correctly');
      console.log('✓ Test 4.3 Passed\n');
    }

    // Test 4.4: Large values
    console.log('Test 4.4: Large values');
    {
      delete require.cache[require.resolve('../src/tools')];
      const tools4 = require('../src/tools');

      // Store a large value (1MB)
      const largeValue = 'x'.repeat(1024 * 1024);
      await tools4.TOOLS.sidekick_store({ key: 'large_key', value: largeValue, project: 'large' });

      // Retrieve it
      const result = await tools4.TOOLS.sidekick_get({ key: 'large_key' });
      assert.strictEqual(result.content[0].text.length, largeValue.length, 'Large value should be preserved');
      
      console.log('✓ Large values handled correctly');
      console.log('✓ Test 4.4 Passed\n');
    }

    // Test 4.5: Special characters in keys and values
    console.log('Test 4.5: Special characters in keys and values');
    {
      delete require.cache[require.resolve('../src/tools')];
      const tools5 = require('../src/tools');

      await tools5.TOOLS.sidekick_store({ 
        key: 'special-key_with.dots:and@chars', 
        value: 'value with "quotes" and \'apostrophes\' and\nnewlines',
        project: 'special'
      });

      const result = await tools5.TOOLS.sidekick_get({ key: 'special-key_with.dots:and@chars' });
      assert.ok(result.content[0].text.includes('quotes'), 'Should preserve quotes');
      assert.ok(result.content[0].text.includes('newlines'), 'Should preserve newlines');
      
      console.log('✓ Special characters handled correctly');
      console.log('✓ Test 4.5 Passed\n');
    }

    // Clean up
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    
    console.log('All Integration Tests Passed! ✓');
    process.exit(0);
  } catch (e) {
    console.error('Test failed:', e);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  }
})();
