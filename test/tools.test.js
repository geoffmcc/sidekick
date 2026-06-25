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

// Now require tools (will use test data dir)
delete require.cache[require.resolve('../src/tools')];
const tools = require('../src/tools');
const dbStore = require('../src/db');
const { 
  TOOLS,
  setSource,
  parseGithubArgs,
  getGithubArg
} = tools;
const { sidekick_store, sidekick_get, sidekick_list_projects, sidekick_get_by_project, sidekick_tools } = TOOLS;

console.log('Running Tools Tests...\n');
(async () => {
  try {
    setSource('mcp');

    // Test 2.0: sidekick_tools broad catalog overview
    console.log('Test 2.0: sidekick_tools broad catalog overview');
    const toolsOverviewResult = await sidekick_tools({ action: 'overview', format: 'json' });
    const toolsOverview = JSON.parse(toolsOverviewResult.content[0].text);
    assert.ok(toolsOverview.total > 0, 'Should report available tools');
    assert.ok(toolsOverview.categories.some(cat => cat.tools.some(tool => tool.name === 'sidekick_tools')), 'Should include sidekick_tools in catalog');
    const toolSearchResult = await sidekick_tools({ action: 'search', query: 'database schema', format: 'json' });
    const toolSearch = JSON.parse(toolSearchResult.content[0].text);
    assert.ok(toolSearch.tools.some(tool => tool.name === 'sidekick_db_schema'), 'Should find tools by broad capability terms');
    console.log('✓ Passed\n');

    // Test 2.0b: sidekick_github argument parsing
    console.log('Test 2.0b: sidekick_github argument parsing');
    const jsonGithubArgs = parseGithubArgs('{"number":28,"method":"merge","ref":"abc123"}');
    assert.strictEqual(getGithubArg(jsonGithubArgs, ['number']), 28, 'Should read JSON PR number');
    assert.strictEqual(getGithubArg(jsonGithubArgs, ['sha', 'ref']), 'abc123', 'Should read JSON ref');
    assert.strictEqual(getGithubArg(parseGithubArgs('28'), ['number']), 28, 'Should preserve numeric legacy args');
    assert.strictEqual(getGithubArg(parseGithubArgs('abc123'), ['sha']), 'abc123', 'Should preserve string legacy args');
    console.log('✓ Passed\n');

    // Test 2.1: sidekick_store with project
    console.log('Test 2.1: sidekick_store with project');
    const result = await sidekick_store({ key: 'test1', value: 'data1', project: 'myproject' });
    assert.ok(result.content[0].text.includes('Stored'), 'Should return success message');
    
    // Verify in KV store
    const kvEntry = dbStore.getKV('test1');
    assert.ok(kvEntry, 'Should exist in store');
    assert.strictEqual(kvEntry.value, 'data1', 'Value should match');
    assert.strictEqual(kvEntry.project, 'myproject', 'Project should match');
    assert.strictEqual(kvEntry.source, 'mcp', 'Source should be mcp');
    console.log('✓ Passed\n');

    // Test 2.2: sidekick_store without project
    console.log('Test 2.2: sidekick_store without project');
    await sidekick_store({ key: 'test2', value: 'data2' });
    const kvEntry2 = dbStore.getKV('test2');
    assert.strictEqual(kvEntry2.project, null, 'Project should be null');
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
    const kvBefore = dbStore.getKV('test_update');
    const createdBefore = kvBefore.created;
    
    // Wait a bit to ensure timestamp would be different
    await new Promise(resolve => setTimeout(resolve, 10));
    
    await sidekick_store({ key: 'test_update', value: 'updated' });
    const kvAfter = dbStore.getKV('test_update');
    assert.strictEqual(kvAfter.value, 'updated', 'Value should be updated');
    assert.strictEqual(kvAfter.created, createdBefore, 'Created should be preserved');
    assert.notStrictEqual(kvAfter.updated, createdBefore, 'Updated should be different');
    console.log('✓ Passed\n');

    // Test 2.9: Update existing key can change project
    console.log('Test 2.9: Update existing key can change project');
    await sidekick_store({ key: 'test_proj_change', value: 'data', project: 'old_proj' });
    await sidekick_store({ key: 'test_proj_change', value: 'data', project: 'new_proj' });
    const kvProj = dbStore.getKV('test_proj_change');
    assert.strictEqual(kvProj.project, 'new_proj', 'Project should be updated');
    console.log('✓ Passed\n');

    // Clean up
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    
    console.log('All Tools Tests Passed! ✓');
  } catch (e) {
    console.error('Test failed:', e);
    process.exit(1);
  }
})();
