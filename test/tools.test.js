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
  logToolCall,
  parseGithubArgs,
  getGithubArg,
  missionRoute
} = tools;
const { sidekick_store, sidekick_get, sidekick_delete, sidekick_resume, sidekick_list_projects, sidekick_get_by_project, sidekick_tools, sidekick_knowledge, sidekick_read, sidekick_write, sidekick_search } = TOOLS;

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
      assert.strictEqual(restrictedPolicy.summary.sources.agent.blocked, 1, 'Should summarize blocked decisions by source');
      assert.strictEqual(restrictedPolicy.decisions[0].allowed, false, 'Agent restricted mode should block critical tools');
      assert.strictEqual(restrictedPolicy.decisions[0].callable, false, 'Blocked tools should not be callable');
      assert.ok(restrictedPolicy.decisions[0].category, 'Should expose tool category for operator visibility');
      assert.ok(restrictedPolicy.decisions[0].description, 'Should expose tool description for operator visibility');
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
      assert.strictEqual(allowedPolicy.summary.sources.agent.allowed, 1, 'Should summarize allowed decisions by source');
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

    console.log('Test 2.0ac: MCP tool logs mirror into platform executions');
    const beforeLogs = dbStore.queryToolLogs({ tool: 'sidekick_status', source: 'mcp', limit: 100 }).length;
    logToolCall('sidekick_status', { action: 'status' }, 12, true, 'status ok', { sessionId: 'sess_test_platform', taskId: 'task_test_platform', project: 'sidekick' });
    const afterLogs = dbStore.queryToolLogs({ tool: 'sidekick_status', source: 'mcp', limit: 100 });
    assert.strictEqual(afterLogs.length, beforeLogs + 1, 'Existing tool_logs behavior should be preserved');
    const platformRow = dbStore.getDb().prepare(`
      SELECT execution_id, state, operation_type, tool_name, tool_action, actor_id, session_id, task_id, project_id
      FROM platform_executions
      WHERE tool_name = 'sidekick_status'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get();
    assert.ok(platformRow, 'MCP tool log should create a platform execution');
    assert.strictEqual(platformRow.state, 'completed');
    assert.strictEqual(platformRow.operation_type, 'tool_call');
    assert.strictEqual(platformRow.tool_action, 'status');
    assert.strictEqual(platformRow.actor_id, 'mcp');
    assert.strictEqual(platformRow.session_id, 'sess_test_platform');
    assert.strictEqual(platformRow.task_id, 'task_test_platform');
    assert.strictEqual(platformRow.project_id, 'sidekick');
    const platformEvents = dbStore.getDb().prepare('SELECT event_type FROM platform_execution_events WHERE execution_id = ? ORDER BY timestamp').all(platformRow.execution_id).map(row => row.event_type);
    assert.ok(platformEvents.includes('execution.created'));
    assert.ok(platformEvents.includes('execution.running'));
    assert.ok(platformEvents.includes('execution.completed'));
    logToolCall('sidekick_generated_double_mirror_guard', { text: 'hello' }, 3, true, 'generated ok', { generatedProcedure: 'sidekick_generated_double_mirror_guard' });
    const generatedMirror = dbStore.getDb().prepare("SELECT COUNT(*) AS count FROM platform_executions WHERE tool_name = 'sidekick_generated_double_mirror_guard'").get();
    assert.strictEqual(generatedMirror.count, 0, 'Generated tool logs should not be double-mirrored by tool_logs adapter');
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

    // Test 2.0ab: sidekick_resume document-backed handoff
    console.log('Test 2.0ab: sidekick_resume document-backed handoff');
    const emptyResume = await sidekick_resume({ action: 'check', project: 'resume_test' });
    assert.ok(emptyResume.content[0].text.includes('No pending resume item'), 'Missing project resume should be explicit');
    const invalidResumeProject = await sidekick_resume({ action: 'set', project: 'Invalid-Project', summary: 'bad' });
    assert.ok(invalidResumeProject.isError, 'Invalid resume project should fail validation');
    const setResume = await sidekick_resume({
      action: 'set',
      project: 'resume_test',
      summary: 'Finish resume workflow PR',
      next_step: 'Open the pull request',
      branch: 'hardening/resume-workflow',
      url: 'https://example.invalid/pr/1',
      format: 'json'
    });
    const resumeItem = JSON.parse(setResume.content[0].text);
    assert.strictEqual(resumeItem.project, 'resume_test', 'Resume item should store project');
    assert.strictEqual(resumeItem.status, 'active', 'Resume item should default to active status');
    assert.strictEqual(resumeItem.next_step, 'Open the pull request', 'Resume item should store next step');
    const checkResume = await sidekick_resume({ action: 'check', project: 'resume_test' });
    assert.ok(checkResume.content[0].text.includes('Finish resume workflow PR'), 'Check should return pending resume summary');
    const listResume = await sidekick_resume({ action: 'list', format: 'json' });
    const listedResume = JSON.parse(listResume.content[0].text);
    assert.ok(listedResume.items.some(item => item.project === 'resume_test'), 'List should include active resume item');
    const clearResume = await sidekick_resume({ action: 'clear', project: 'resume_test' });
    assert.ok(clearResume.content[0].text.includes('Resume cleared'), 'Clear should report success');
    const clearedCheck = await sidekick_resume({ action: 'check', project: 'resume_test' });
    assert.ok(clearedCheck.content[0].text.includes('No pending resume item'), 'Cleared resume should not be pending');
    const listActiveAfterClear = JSON.parse((await sidekick_resume({ action: 'list', format: 'json' })).content[0].text);
    assert.ok(!listActiveAfterClear.items.some(item => item.project === 'resume_test'), 'Default list should hide cleared items');
    const listCleared = JSON.parse((await sidekick_resume({ action: 'list', include_cleared: true, format: 'json' })).content[0].text);
    assert.ok(listCleared.items.some(item => item.project === 'resume_test' && item.status === 'cleared'), 'include_cleared should show cleared items');
    console.log('✓ Passed\n');

    // Test 2.0aba: plan-scoped resume fields and phase numbering
    console.log('Test 2.0aba: plan-scoped resume fields and phase numbering');

    // --- plan_name and current_phase persistence ---
    const planResume = await sidekick_resume({
      action: 'set',
      project: 'resume_plan_test',
      summary: 'Scoped handoff plan work',
      next_step: 'Implement Phase 4',
      plan_name: 'Nodex Initial Capability Handoff',
      current_phase: 4,
      format: 'json'
    });
    const planItem = JSON.parse(planResume.content[0].text);
    assert.strictEqual(planItem.plan_name, 'Nodex Initial Capability Handoff', 'Should store plan_name');
    assert.strictEqual(planItem.current_phase, 4, 'Should store current_phase as number');
    assert.strictEqual(planItem.status, 'active', 'New plan should default to active');

    const planCheck = await sidekick_resume({ action: 'check', project: 'resume_plan_test' });
    assert.ok(planCheck.content[0].text.includes('Nodex Initial Capability Handoff'), 'Check should display plan_name');
    assert.ok(planCheck.content[0].text.includes('Current phase: 4'), 'Check should display current_phase');

    // --- Same plan continues: phase 4 → 5 ---
    const continuedPlan = await sidekick_resume({
      action: 'set',
      project: 'resume_plan_test',
      summary: 'Continuing same plan',
      next_step: 'Implement Phase 5',
      plan_name: 'Nodex Initial Capability Handoff',
      current_phase: 5,
      format: 'json'
    });
    const continuedItem = JSON.parse(continuedPlan.content[0].text);
    assert.strictEqual(continuedItem.plan_name, 'Nodex Initial Capability Handoff', 'Continued plan should keep plan_name');
    assert.strictEqual(continuedItem.current_phase, 5, 'Continued plan should increment phase');
    assert.strictEqual(continuedItem.status, 'active', 'Continued plan should stay active');

    // --- Mark a plan complete ---
    const completeResume = await sidekick_resume({
      action: 'set',
      project: 'resume_plan_test',
      summary: 'All phases complete',
      next_step: 'None — handoff complete',
      plan_name: 'Nodex Initial Capability Handoff',
      current_phase: 13,
      status: 'complete',
      format: 'json'
    });
    const completeItem = JSON.parse(completeResume.content[0].text);
    assert.strictEqual(completeItem.status, 'complete', 'Plan should accept complete status');

    // --- Completed plan hidden from active list ---
    const activeList = await sidekick_resume({ action: 'list', format: 'json' });
    const activeItems = JSON.parse(activeList.content[0].text);
    assert.ok(!activeItems.items.some(item => item.project === 'resume_plan_test'), 'Complete plan should not appear in active list');

    // --- Completed plan visible in cleared list ---
    const clearedList = await sidekick_resume({ action: 'list', include_cleared: true, format: 'json' });
    const clearedItems = JSON.parse(clearedList.content[0].text);
    assert.ok(clearedItems.items.some(item => item.project === 'resume_plan_test' && item.status === 'complete'), 'Complete plan should appear when include_cleared is true');

    // --- New plan starts at Phase 1, not derived from completed plan ---
    const newPlan = await sidekick_resume({
      action: 'set',
      project: 'resume_plan_test_new',
      summary: 'New unrelated work',
      next_step: 'Implement Phase 1',
      plan_name: 'Nodex Proxmox Capability Expansion',
      current_phase: 1,
      format: 'json'
    });
    const newPlanItem = JSON.parse(newPlan.content[0].text);
    assert.strictEqual(newPlanItem.plan_name, 'Nodex Proxmox Capability Expansion', 'New plan should have new plan_name');
    assert.strictEqual(newPlanItem.current_phase, 1, 'New plan should start at Phase 1, not Phase 14');

    // --- Multiple plans in same project are independent ---
    await sidekick_resume({
      action: 'set',
      project: 'resume_multiple_plans',
      summary: 'Plan B work',
      next_step: 'Implement Phase 3',
      plan_name: 'Plan B',
      current_phase: 3,
      format: 'json'
    });

    // --- Legacy item without plan_name displays correctly ---
    const legacyResume = await sidekick_resume({
      action: 'set',
      project: 'resume_legacy_test',
      summary: 'Legacy handoff without explicit plan',
      next_step: 'Complete remaining work',
      format: 'json'
    });
    const legacyItem = JSON.parse(legacyResume.content[0].text);
    assert.strictEqual(legacyItem.plan_name, null, 'Legacy item without plan_name should store null');
    assert.strictEqual(legacyItem.current_phase, null, 'Legacy item without current_phase should store null');
    const legacyCheck = await sidekick_resume({ action: 'check', project: 'resume_legacy_test' });
    assert.ok(!legacyCheck.content[0].text.includes('Plan:'), 'Legacy item should not display Plan: without plan_name');
    assert.ok(!legacyCheck.content[0].text.includes('Current phase:'), 'Legacy item should not display phase without current_phase');

    // Cleanup test projects
    await sidekick_resume({ action: 'clear', project: 'resume_plan_test' });
    await sidekick_resume({ action: 'clear', project: 'resume_plan_test_new' });
    await sidekick_resume({ action: 'clear', project: 'resume_multiple_plans' });
    await sidekick_resume({ action: 'clear', project: 'resume_legacy_test' });
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
    const policyRoute = missionRoute('why is sidekick_bash allowed for agent policy?', 'read_only_audit', { tool: 'sidekick_bash', source: 'agent', format: 'json' });
    assert.strictEqual(policyRoute.route, 'policy', 'Should route policy visibility intent');
    assert.strictEqual(policyRoute.allowed, true, 'Read-only audit should allow policy inspection');
    assert.strictEqual(policyRoute.recommended_tool, 'sidekick_tools', 'Policy should route to sidekick_tools');
    assert.strictEqual(policyRoute.recommended_args.action, 'policy', 'Policy route should use policy action');
    assert.strictEqual(policyRoute.recommended_args.name, 'sidekick_bash', 'Policy route should pass requested tool name');
    assert.strictEqual(policyRoute.recommended_args.source, 'agent', 'Policy route should pass requested source');
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
