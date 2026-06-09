const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Set up test data directory
const TEST_DATA_DIR = path.join(__dirname, 'test-data');
if (!fs.existsSync(TEST_DATA_DIR)) {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

// Set environment variable before requiring tools
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

// Clean up test data
const testKVFile = path.join(TEST_DATA_DIR, 'kvstore.json');
if (fs.existsSync(testKVFile)) {
  fs.unlinkSync(testKVFile);
}

// Now require tools (will use test data dir)
delete require.cache[require.resolve('../src/tools')];
const tools = require('../src/tools');
const { 
  TOOLS,
  setSource 
} = tools;
const { sidekick_store, sidekick_get, sidekick_list_projects, sidekick_get_by_project } = TOOLS;

console.log('Running Tools Tests...\n');

// Test 2.1: sidekick_store with project
console.log('Test 2.1: sidekick_store with project');
(async () => {
  try {
    setSource('mcp');
    const result = await sidekick_store({ key: 'test1', value: 'data1', project: 'myproject' });
    assert.ok(result.content[0].text.includes('Stored'), 'Should return success message');
    
    // Verify in KV store
    const kvData = JSON.parse(fs.readFileSync(testKVFile, 'utf-8'));
    assert.strictEqual(typeof kvData['test1'], 'object', 'Should store as object');
    assert.strictEqual(kvData['test1'].value, 'data1', 'Value should match');
    assert.strictEqual(kvData['test1'].project, 'myproject', 'Project should match');
    assert.strictEqual(kvData['test1'].source, 'mcp', 'Source should be mcp');
    console.log('✓ Passed\n');

    // Test 2.2: sidekick_store without project
    console.log('Test 2.2: sidekick_store without project');
    await sidekick_store({ key: 'test2', value: 'data2' });
    const kvData2 = JSON.parse(fs.readFileSync(testKVFile, 'utf-8'));
    assert.strictEqual(kvData2['test2'].project, null, 'Project should be null');
    console.log('✓ Passed\n');

    // Test 2.3: sidekick_get backward compatibility
    console.log('Test 2.3: sidekick_get backward compatibility');
    const getResult = await sidekick_get({ key: 'test1' });
    assert.strictEqual(getResult.content[0].text, 'data1', 'Should return just the value string');
    assert.ok(!getResult.content[0].text.includes('project'), 'Should not include metadata');
    console.log('✓ Passed\n');

    // Test 2.4: sidekick_get missing key
    console.log('Test 2.4: sidekick_get missing key');
    const missingResult = await sidekick_get({ key: 'nonexistent' });
    assert.ok(missingResult.isError, 'Should return error');
    assert.ok(missingResult.content[0].text.includes('Key not found'), 'Should say key not found');
    console.log('✓ Passed\n');

    // Test 2.5: sidekick_list_projects
    console.log('Test 2.5: sidekick_list_projects');
    await sidekick_store({ key: 'test3', value: 'data3', project: 'proj1' });
    await sidekick_store({ key: 'test4', value: 'data4', project: 'proj2' });
    await sidekick_store({ key: 'test5', value: 'data5' }); // null project
    
    const projectsResult = await sidekick_list_projects();
    const projects = JSON.parse(projectsResult.content[0].text);
    assert.ok(Array.isArray(projects), 'Should return array');
    assert.ok(projects.includes('proj1'), 'Should include proj1');
    assert.ok(projects.includes('proj2'), 'Should include proj2');
    assert.ok(projects.includes(null), 'Should include null project');
    console.log('✓ Passed\n');

    // Test 2.6: sidekick_get_by_project
    console.log('Test 2.6: sidekick_get_by_project');
    const proj1Result = await sidekick_get_by_project({ project: 'proj1' });
    const proj1Keys = JSON.parse(proj1Result.content[0].text);
    assert.ok(Array.isArray(proj1Keys), 'Should return array');
    assert.strictEqual(proj1Keys.length, 1, 'Should have 1 key');
    assert.strictEqual(proj1Keys[0].key, 'test3', 'Should be test3');
    assert.strictEqual(proj1Keys[0].value, 'data3', 'Value should match');
    console.log('✓ Passed\n');

    // Test 2.6b: Get by null project
    console.log('Test 2.6b: sidekick_get_by_project with null project');
    const nullProjResult = await sidekick_get_by_project({ project: null });
    const nullProjKeys = JSON.parse(nullProjResult.content[0].text);
    assert.ok(Array.isArray(nullProjKeys), 'Should return array');
    assert.ok(nullProjKeys.length >= 2, 'Should have at least 2 keys (test2 and test5)');
    console.log('✓ Passed\n');

    // Test 2.7: Project naming validation
    console.log('Test 2.7: Project naming validation');
    const invalidResult = await sidekick_store({ key: 'test_invalid', value: 'data', project: 'Invalid-Project' });
    assert.ok(invalidResult.isError, 'Should return error for invalid project name');
    assert.ok(invalidResult.content[0].text.includes('Invalid project name'), 'Should mention invalid project name');
    console.log('✓ Passed\n');

    // Test 2.8: Update existing key preserves created timestamp
    console.log('Test 2.8: Update existing key preserves created timestamp');
    await sidekick_store({ key: 'test_update', value: 'original' });
    const kvBefore = JSON.parse(fs.readFileSync(testKVFile, 'utf-8'));
    const createdBefore = kvBefore['test_update'].created;
    
    // Wait a bit to ensure timestamp would be different
    await new Promise(resolve => setTimeout(resolve, 10));
    
    await sidekick_store({ key: 'test_update', value: 'updated' });
    const kvAfter = JSON.parse(fs.readFileSync(testKVFile, 'utf-8'));
    assert.strictEqual(kvAfter['test_update'].value, 'updated', 'Value should be updated');
    assert.strictEqual(kvAfter['test_update'].created, createdBefore, 'Created should be preserved');
    assert.notStrictEqual(kvAfter['test_update'].updated, createdBefore, 'Updated should be different');
    console.log('✓ Passed\n');

    // Test 2.9: Update existing key can change project
    console.log('Test 2.9: Update existing key can change project');
    await sidekick_store({ key: 'test_proj_change', value: 'data', project: 'old_proj' });
    await sidekick_store({ key: 'test_proj_change', value: 'data', project: 'new_proj' });
    const kvProj = JSON.parse(fs.readFileSync(testKVFile, 'utf-8'));
    assert.strictEqual(kvProj['test_proj_change'].project, 'new_proj', 'Project should be updated');
    console.log('✓ Passed\n');

    // Clean up
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    
    console.log('All Tools Tests Passed! ✓');
  } catch (e) {
    console.error('Test failed:', e);
    process.exit(1);
  }
})();
