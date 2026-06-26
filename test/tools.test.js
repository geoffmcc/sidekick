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
  getGithubArg,
  missionRoute
} = tools;
const { sidekick_store, sidekick_get, sidekick_delete, sidekick_list_projects, sidekick_get_by_project, sidekick_tools, sidekick_knowledge, sidekick_read, sidekick_write, sidekick_search } = TOOLS;

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

    // Test 2.0a: sidekick_tools policy inspector
    console.log('Test 2.0a: sidekick_tools policy inspector');
    const policyEnvKeys = [
      'SIDEKICK_TOOL_POLICY',
      'SIDEKICK_ALLOWED_TOOLS',
      'SIDEKICK_BLOCKED_TOOLS',
      'SIDEKICK_AGENT_TOOL_POLICY',
      'SIDEKICK_AGENT_ALLOWED_TOOLS',
      'SIDEKICK_AGENT_BLOCKED_TOOLS',
      'SIDEKICK_DASHBOARD_APPROVAL_MODE',
      'SIDEKICK_DASHBOARD_APPROVAL_REQUIRED_TOOLS',
      'SIDEKICK_DASHBOARD_APPROVAL_EXEMPT_TOOLS'
    ];
    const savedPolicyEnv = Object.fromEntries(policyEnvKeys.map(key => [key, process.env[key]]));
    try {
      for (const key of policyEnvKeys) delete process.env[key];

      process.env.SIDEKICK_AGENT_TOOL_POLICY = 'restricted';
      const restrictedPolicyResult = await sidekick_tools({
        action: 'policy',
        name: 'sidekick_bash',
        source: 'agent',
        format: 'json'
      });
      const restrictedPolicy = JSON.parse(restrictedPolicyResult.content[0].text);
      assert.strictEqual(restrictedPolicy.total, 1, 'Should inspect one source/tool decision');
      assert.strictEqual(restrictedPolicy.decisions[0].allowed, false, 'Agent restricted mode should block critical tools');
      assert.strictEqual(restrictedPolicy.decisions[0].policy.reason, 'restricted policy blocks high and critical risk tools');

      process.env.SIDEKICK_AGENT_ALLOWED_TOOLS = 'sidekick_bash';
      const allowedPolicyResult = await sidekick_tools({
        action: 'policy',
        name: 'sidekick_bash',
        source: 'agent',
        format: 'json'
      });
      const allowedPolicy = JSON.parse(allowedPolicyResult.content[0].text);
      assert.strictEqual(allowedPolicy.decisions[0].allowed, true, 'Explicit allowlist should allow the tool');
      assert.strictEqual(allowedPolicy.decisions[0].policy.matched, 'sidekick_bash', 'Should expose matched allowlist selector');

      process.env.SIDEKICK_AGENT_BLOCKED_TOOLS = 'sidekick_bash';
      const blockedPolicyResult = await sidekick_tools({
        action: 'policy',
        name: 'sidekick_bash',
        source: 'agent',
        format: 'json'
      });
      const blockedPolicy = JSON.parse(blockedPolicyResult.content[0].text);
      assert.strictEqual(blockedPolicy.decisions[0].allowed, false, 'Blocklist should win over allowlist');
      assert.strictEqual(blockedPolicy.decisions[0].policy.list, 'blocked', 'Should identify the blocking list');

      process.env.SIDEKICK_DASHBOARD_APPROVAL_MODE = 'strict';
      const approvalPolicyResult = await sidekick_tools({
        action: 'policy',
        name: 'sidekick_service',
        source: 'dashboard',
        format: 'json'
      });
      const approvalPolicy = JSON.parse(approvalPolicyResult.content[0].text);
      assert.strictEqual(approvalPolicy.decisions[0].approval_required, true, 'Strict approval mode should require high-risk approval');
      assert.strictEqual(approvalPolicy.decisions[0].approval.reason, 'strict mode requires approval for high and critical risk tools');
    } finally {
      for (const [key, value] of Object.entries(savedPolicyEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    console.log('✓ Passed\n');

    // Test 2.0aa: filesystem path guard
    console.log('Test 2.0aa: filesystem path guard');
    const pathEnvKeys = [
      'SIDEKICK_ALLOWED_PATHS',
      'SIDEKICK_DENIED_PATHS',
      'SIDEKICK_AGENT_ALLOWED_PATHS',
      'SIDEKICK_AGENT_DENIED_PATHS'
    ];
    const savedPathEnv = Object.fromEntries(pathEnvKeys.map(key => [key, process.env[key]]));
    const allowedDir = path.join(TEST_DATA_DIR, 'allowed');
    const deniedDir = path.join(TEST_DATA_DIR, 'denied');
    const outsideDir = path.join(TEST_DATA_DIR, 'outside');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(deniedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const allowedFile = path.join(allowedDir, 'ok.txt');
    const deniedFile = path.join(deniedDir, 'secret.txt');
    const outsideFile = path.join(outsideDir, 'outside.txt');
    fs.writeFileSync(allowedFile, 'allowed content', 'utf-8');
    fs.writeFileSync(deniedFile, 'denied content', 'utf-8');
    fs.writeFileSync(outsideFile, 'outside content', 'utf-8');
    try {
      for (const key of pathEnvKeys) delete process.env[key];
      setSource('mcp');

      const defaultRead = await sidekick_read({ path: outsideFile });
      assert.ok(!defaultRead.isError, 'Unset path policy should preserve open filesystem access');

      process.env.SIDEKICK_ALLOWED_PATHS = allowedDir;
      const allowedRead = await sidekick_read({ path: allowedFile });
      assert.ok(!allowedRead.isError, 'Allowed path should be readable');
      const blockedRead = await sidekick_read({ path: outsideFile });
      assert.ok(blockedRead.isError, 'Path outside allowlist should be blocked');
      assert.ok(blockedRead.content[0].text.includes('Path blocked by policy'), 'Blocked path should explain policy block');

      const blockedWrite = await sidekick_write({ path: outsideFile, content: 'blocked' });
      assert.ok(blockedWrite.isError, 'Writes outside allowlist should be blocked');
      assert.strictEqual(fs.readFileSync(outsideFile, 'utf-8'), 'outside content', 'Blocked write should not modify file');

      process.env.SIDEKICK_DENIED_PATHS = deniedDir;
      process.env.SIDEKICK_ALLOWED_PATHS = TEST_DATA_DIR;
      const deniedRead = await sidekick_read({ path: deniedFile });
      assert.ok(deniedRead.isError, 'Deny list should win over allowlist');

      delete process.env.SIDEKICK_ALLOWED_PATHS;
      delete process.env.SIDEKICK_DENIED_PATHS;
      process.env.SIDEKICK_AGENT_ALLOWED_PATHS = allowedDir;
      setSource('agent');
      const agentBlockedSearch = await sidekick_search({ pattern: 'outside', path: outsideDir });
      assert.ok(agentBlockedSearch.isError, 'Source-specific allowed paths should block that source');
      setSource('mcp');
      const mcpOpenSearch = await sidekick_search({ pattern: 'outside', path: outsideDir });
      assert.ok(!mcpOpenSearch.isError, 'Source-specific allowed paths should not affect other sources');
    } finally {
      for (const [key, value] of Object.entries(savedPathEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      setSource('mcp');
    }
    console.log('✓ Passed\n');

    // Test 2.0b: sidekick_github argument parsing
    console.log('Test 2.0b: sidekick_github argument parsing');
    const jsonGithubArgs = parseGithubArgs('{"number":28,"method":"merge","ref":"abc123"}');
    assert.strictEqual(getGithubArg(jsonGithubArgs, ['number']), 28, 'Should read JSON PR number');
    assert.strictEqual(getGithubArg(jsonGithubArgs, ['sha', 'ref']), 'abc123', 'Should read JSON ref');
    assert.strictEqual(getGithubArg(parseGithubArgs('28'), ['number']), 28, 'Should preserve numeric legacy args');
    assert.strictEqual(getGithubArg(parseGithubArgs('abc123'), ['sha']), 'abc123', 'Should preserve string legacy args');
    console.log('✓ Passed\n');

    // Test 2.0c: sidekick_mission deterministic routing
    console.log('Test 2.0c: sidekick_mission deterministic routing');
    const deployRoute = missionRoute('deploy current main', 'trusted_vps', { repo_path: '/srv/sidekick' });
    assert.strictEqual(deployRoute.route, 'deploy', 'Should route deploy intent');
    assert.strictEqual(deployRoute.recommended_tool, 'sidekick_ops', 'Deploy should route to sidekick_ops');
    assert.strictEqual(deployRoute.recommended_args.action, 'deploy_current_main', 'Deploy should use deploy_current_main');
    assert.strictEqual(deployRoute.requires_confirmation, true, 'Deploy should require confirmation');
    const blockedDeploy = missionRoute('deploy current main', 'production');
    assert.strictEqual(blockedDeploy.allowed, false, 'Production profile should block direct deploy');
    const statusRoute = missionRoute('check service health', 'read_only_audit');
    assert.strictEqual(statusRoute.route, 'status', 'Should route status intent');
    assert.strictEqual(statusRoute.allowed, true, 'Read-only audit should allow status');
    console.log('✓ Passed\n');

    // Test 2.0d: sidekick_knowledge soft delete and purge
    console.log('Test 2.0d: sidekick_knowledge soft delete and purge');
    dbStore.runPendingMigrations();
    const addKnowledgeResult = await sidekick_knowledge({
      action: 'add',
      category: 'test',
      title: 'Temporary purge test',
      content: 'temporary content'
    });
    const addedId = Number(addKnowledgeResult.content[0].text.match(/id: (\d+)/)[1]);
    const activePurgeResult = await sidekick_knowledge({ action: 'purge', id: addedId });
    assert.ok(activePurgeResult.isError, 'Should not purge enabled entries');
    assert.ok(activePurgeResult.content[0].text.includes('Run action=delete first'), 'Should require soft delete before purge');
    const softDeleteResult = await sidekick_knowledge({ action: 'delete', id: addedId });
    assert.ok(softDeleteResult.content[0].text.includes('Soft-deleted'), 'Delete should be explicit soft delete');
    const disabledRow = dbStore.getDb().prepare('SELECT enabled FROM knowledge WHERE id = ?').get(addedId);
    assert.strictEqual(disabledRow.enabled, 0, 'Soft-deleted row should remain disabled');
    const purgeResult = await sidekick_knowledge({ action: 'purge', id: addedId });
    assert.ok(purgeResult.content[0].text.includes('Purged disabled knowledge entry'), 'Should purge disabled entry');
    const purgedRow = dbStore.getDb().prepare('SELECT id FROM knowledge WHERE id = ?').get(addedId);
    assert.strictEqual(purgedRow, undefined, 'Purged row should be physically removed');
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

    // Test 2.5: sidekick_delete
    console.log('Test 2.5: sidekick_delete');
    await sidekick_store({ key: 'delete_me', value: 'temporary', project: 'proj_delete' });
    const deleteResult = await sidekick_delete({ key: 'delete_me' });
    assert.ok(deleteResult.content[0].text.includes('Deleted key'), 'Should return deleted message');
    assert.strictEqual(dbStore.getKV('delete_me'), null, 'Key should be deleted');
    const deleteMissingResult = await sidekick_delete({ key: 'delete_me' });
    assert.ok(deleteMissingResult.isError, 'Should return error for missing delete key');
    assert.ok(deleteMissingResult.content[0].text.includes('Key not found'), 'Should say key not found');
    console.log('✓ Passed\n');

    // Test 2.6: sidekick_list_projects
    console.log('Test 2.6: sidekick_list_projects');
    await sidekick_store({ key: 'test3', value: 'data3', project: 'proj1' });
    await sidekick_store({ key: 'test4', value: 'data4', project: 'proj2' });
    await sidekick_store({ key: 'test5', value: 'data5' }); // null project
    
    const projectsResult = await sidekick_list_projects();
    const projects = JSON.parse(projectsResult.content[0].text);
    assert.ok(Array.isArray(projects), 'Should return array');
    assert.ok(projects.includes('proj1'), 'Should include proj1');
    assert.ok(projects.includes('proj2'), 'Should include proj2');
    console.log('✓ Passed\n');

    // Test 2.7: sidekick_get_by_project
    console.log('Test 2.7: sidekick_get_by_project');
    const proj1Result = await sidekick_get_by_project({ project: 'proj1' });
    const proj1Keys = JSON.parse(proj1Result.content[0].text);
    assert.ok(Array.isArray(proj1Keys), 'Should return array');
    assert.strictEqual(proj1Keys.length, 1, 'Should have 1 key');
    assert.strictEqual(proj1Keys[0].key, 'test3', 'Should be test3');
    assert.strictEqual(proj1Keys[0].value, 'data3', 'Value should match');
    console.log('✓ Passed\n');

    // Test 2.7b: Get by null project
    console.log('Test 2.7b: sidekick_get_by_project with null project');
    const nullProjResult = await sidekick_get_by_project({ project: null });
    const nullProjKeys = JSON.parse(nullProjResult.content[0].text);
    assert.ok(Array.isArray(nullProjKeys), 'Should return array');
    assert.ok(nullProjKeys.length >= 2, 'Should have at least 2 keys (test2 and test5)');
    console.log('✓ Passed\n');

    // Test 2.8: Project naming validation
    console.log('Test 2.8: Project naming validation');
    const invalidResult = await sidekick_store({ key: 'test_invalid', value: 'data', project: 'Invalid-Project' });
    assert.ok(invalidResult.isError, 'Should return error for invalid project name');
    assert.ok(invalidResult.content[0].text.includes('Invalid project name'), 'Should mention invalid project name');
    console.log('✓ Passed\n');

    // Test 2.9: Update existing key preserves created timestamp
    console.log('Test 2.9: Update existing key preserves created timestamp');
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

    // Test 2.10: Update existing key can change project
    console.log('Test 2.10: Update existing key can change project');
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
