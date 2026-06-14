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

    // Test 4.2: Concurrent operations
    console.log('Test 4.2: Concurrent operations');
    {
      // Clear KV using dbStore
      const dbStore = require('../src/db');
      dbStore.clearKV();
      
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

      // Verify all were stored using get_by_project
      const evenResult = await tools3.TOOLS.sidekick_get_by_project({ project: 'even' });
      const evenKeys = JSON.parse(evenResult.content[0].text);
      assert.strictEqual(evenKeys.length, 5, 'Should have 5 even keys');
      
      const oddResult = await tools3.TOOLS.sidekick_get_by_project({ project: 'odd' });
      const oddKeys = JSON.parse(oddResult.content[0].text);
      assert.strictEqual(oddKeys.length, 5, 'Should have 5 odd keys');
      
      console.log('✓ Concurrent operations handled correctly');
      console.log('✓ Test 4.2 Passed\n');
    }

    // Test 4.3: Large values
    console.log('Test 4.3: Large values');
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
      console.log('✓ Test 4.3 Passed\n');
    }

    // Test 4.4: Special characters in keys and values
    console.log('Test 4.4: Special characters in keys and values');
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
      console.log('✓ Test 4.4 Passed\n');
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
