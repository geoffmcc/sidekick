const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-approval-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = '';
process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = '';
process.env.SIDEKICK_APPROVAL_TTL_SECONDS = '3600';
process.env.SIDEKICK_SECRET_KEY = 'approval-test-secret-key';

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];
const tools = require('../src/tools');
const db = require('../src/db');

console.log('Running Approval Tests...\n');

(async () => {
  try {
    tools.setSource('mcp');

    console.log('Test 1: approval mode off preserves immediate execution');
    let result = await tools.callTool('sidekick_respond', { text: 'hello' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'hello');
    assert.strictEqual(tools.listApprovals().length, 0);
    console.log('Passed\n');

    console.log('Test 2: required tool queues approval');
    process.env.SIDEKICK_APPROVAL_MODE = 'risky';
    process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = 'sidekick_respond';
    result = await tools.callTool('sidekick_respond', {
      text: 'queued',
      password: 'short-secret',
      nested: { authorization: 'Bearer visible-looking-value' }
    });
    assert.ok(result.isError);
    assert.ok(result.approvalRequired);
    assert.ok(result.approvalId);
    let approvals = tools.listApprovals({ status: 'pending' });
    assert.strictEqual(approvals.length, 1);
    assert.strictEqual(approvals[0].tool, 'sidekick_respond');
    assert.ok(!Object.prototype.hasOwnProperty.call(approvals[0], 'args'));
    assert.ok(!Object.prototype.hasOwnProperty.call(approvals[0], 'args_encrypted'));
    assert.ok(!approvals[0].args_preview.includes('short-secret'));
    assert.ok(!approvals[0].args_preview.includes('visible-looking-value'));
    const storedApproval = db.loadDocument('approvals', [])[0];
    assert.ok(storedApproval.args_encrypted);
    assert.ok(storedApproval.platform_execution_id);
    assert.ok(!Object.prototype.hasOwnProperty.call(storedApproval, 'args'));
    assert.ok(!JSON.stringify(storedApproval).includes('short-secret'));
    const approvalExecution = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(storedApproval.platform_execution_id);
    assert.strictEqual(approvalExecution.operation_type, 'approval_request');
    assert.strictEqual(approvalExecution.tool_name, 'sidekick_respond');
    assert.strictEqual(approvalExecution.state, 'awaiting_approval');
    assert.strictEqual(approvalExecution.approval_state, 'pending');
    const requestedEvent = db.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'approval.requested' AND subject_id = ?").get(storedApproval.id);
    assert.ok(requestedEvent);
    assert.ok(!requestedEvent.payload_json.includes('short-secret'));
    assert.ok(!requestedEvent.payload_json.includes('visible-looking-value'));
    console.log('Passed\n');

    console.log('Test 2b: ordinary caller cannot bypass approval with option flags');
    result = await tools.callTool('sidekick_respond', { text: 'forged bypass' }, { bypassApproval: true, approvalBypass: true, source: 'mcp' });
    assert.ok(result.isError);
    assert.strictEqual(result.code, 'approval_required');
    assert.notStrictEqual(result.content[0].text, 'forged bypass');
    const forgedBypassId = result.approvalId;
    result = await tools.resolveApproval(forgedBypassId, 'reject', 'test');
    assert.strictEqual(result.isError, undefined);
    console.log('Passed\n');

    console.log('Test 3: approving a queued request executes it');
    result = await tools.resolveApproval(approvals[0].id, 'approve', 'test');
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'queued');
    approvals = tools.listApprovals({ status: 'approved' });
    assert.strictEqual(approvals.length, 1);
    const completedApproval = db.loadDocument('approvals', []).find(item => item.id === approvals[0].id);
    assert.ok(!Object.prototype.hasOwnProperty.call(completedApproval, 'args_encrypted'));
    const completedExecution = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(completedApproval.platform_execution_id);
    assert.strictEqual(completedExecution.state, 'completed');
    assert.strictEqual(completedExecution.result_status, 'success');
    const childExecution = db.getDb().prepare("SELECT * FROM platform_executions WHERE parent_execution_id = ? AND operation_type = 'tool_call'").get(completedApproval.platform_execution_id);
    assert.ok(childExecution);
    assert.strictEqual(childExecution.root_execution_id, completedApproval.platform_execution_id);
    const completedEvent = db.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'approval.completed' AND subject_id = ?").get(completedApproval.id);
    assert.ok(completedEvent);
    console.log('Passed\n');

    console.log('Test 3b: approval uses stored arguments despite caller mutation');
    const mutableArgs = { text: 'before mutation', nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz123456' } };
    result = await tools.callTool('sidekick_respond', mutableArgs, { source: 'mcp' });
    const mutationApprovalId = result.approvalId;
    mutableArgs.text = 'after mutation';
    mutableArgs.nested.token = 'changed-token';
    result = await tools.resolveApproval(mutationApprovalId, 'approve', 'test');
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'before mutation');
    console.log('Passed\n');

    console.log('Test 3c: approval replay and concurrent duplicate execution are blocked');
    result = await tools.callTool('sidekick_respond', { text: 'single execution' }, { source: 'mcp' });
    const replayApprovalId = result.approvalId;
    const [firstRun, secondRun] = await Promise.all([
      tools.resolveApproval(replayApprovalId, 'approve', 'test'),
      tools.resolveApproval(replayApprovalId, 'approve', 'test'),
    ]);
    const successes = [firstRun, secondRun].filter(item => !item.isError);
    const failures = [firstRun, secondRun].filter(item => item.isError);
    assert.strictEqual(successes.length, 1);
    assert.strictEqual(failures.length, 1);
    result = await tools.resolveApproval(replayApprovalId, 'approve', 'test');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already approved') || result.content[0].text.includes('already executing'));
    console.log('Passed\n');

    console.log('Test 3d: tampered stored arguments fail authentication');
    result = await tools.callTool('sidekick_respond', { text: 'tamper me' }, { source: 'mcp' });
    const tamperApprovalId = result.approvalId;
    const tamperedApprovals = db.loadDocument('approvals', []);
    const tampered = tamperedApprovals.find(item => item.id === tamperApprovalId);
    tampered.args_hash = '0'.repeat(64);
    db.setDocument('approvals', tamperedApprovals);
    result = await tools.resolveApproval(tamperApprovalId, 'approve', 'test');
    assert.ok(result.isError);
    assert.strictEqual(result.code, 'approval_payload_invalid');
    console.log('Passed\n');

    console.log('Test 3e: invented approval IDs cannot execute');
    result = await require('../src/tools/dispatcher').executeApprovedTool({ approvalId: 'approval_does_not_exist', reviewer: 'test' });
    assert.ok(result.isError);
    assert.strictEqual(result.code, 'approval_not_found');
    console.log('Passed\n');

    console.log('Test 3f: approval claims are leased and ownership-checked');
    result = await tools.callTool('sidekick_respond', { text: 'lease me' }, { source: 'mcp' });
    const leaseApprovalId = result.approvalId;
    const claim = tools.claimApprovalExecution({ approvalId: leaseApprovalId, reviewer: 'test' });
    assert.strictEqual(claim.isError, undefined);
    assert.ok(claim.operationId);
    assert.ok(claim.executorId);
    let storedLease = db.loadDocument('approvals', []).find(item => item.id === leaseApprovalId);
    assert.strictEqual(storedLease.status, 'executing');
    assert.ok(storedLease.lease_expires_at);
    result = tools.claimApprovalExecution({ approvalId: leaseApprovalId, reviewer: 'test' });
    assert.ok(result.isError);
    assert.strictEqual(result.code, 'approval_lease_active');
    result = tools.renewApprovalLease({ approvalId: leaseApprovalId, operationId: claim.operationId, executorId: 'wrong-executor' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'lease_owner_mismatch');
    result = tools.finalizeApprovalExecution({ approvalId: leaseApprovalId, reviewer: 'test', operationId: claim.operationId, executorId: 'wrong-executor', result: { content: [{ type: 'text', text: 'wrong' }] }, args: claim.args });
    assert.strictEqual(result.finalizeRejected, true);
    tools.finalizeApprovalExecution({ approvalId: leaseApprovalId, reviewer: 'test', operationId: claim.operationId, executorId: claim.executorId, result: { content: [{ type: 'text', text: 'lease ok' }] }, args: claim.args });
    storedLease = db.loadDocument('approvals', []).find(item => item.id === leaseApprovalId);
    assert.strictEqual(storedLease.status, 'approved');
    console.log('Passed\n');

    console.log('Test 3g: stale high-risk leases require reconciliation and low-risk can be recovered only by policy');
    result = await tools.callTool('sidekick_respond', { text: 'stale high' }, { source: 'mcp' });
    const staleHighId = result.approvalId;
    const staleHighClaim = tools.claimApprovalExecution({ approvalId: staleHighId, reviewer: 'test' });
    let staleApprovals = db.loadDocument('approvals', []);
    let staleHigh = staleApprovals.find(item => item.id === staleHighId);
    staleHigh.risk = 'critical';
    staleHigh.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    db.setDocument('approvals', staleApprovals);
    result = tools.claimApprovalExecution({ approvalId: staleHighId, reviewer: 'test', allowStaleReclaim: true });
    assert.ok(result.isError);
    assert.strictEqual(result.code, 'reconciliation_required');
    staleHigh = db.loadDocument('approvals', []).find(item => item.id === staleHighId);
    assert.strictEqual(staleHigh.status, 'reconciliation_required');
    assert.strictEqual(staleHigh.reconciliation_status, 'manual_review');

    result = await tools.callTool('sidekick_respond', { text: 'timeout reconcile' }, { source: 'mcp', timeoutMs: 5 });
    const timeoutApprovalId = result.approvalId;
    const timeoutClaim = tools.claimApprovalExecution({ approvalId: timeoutApprovalId, reviewer: 'test' });
    assert.strictEqual(timeoutClaim.timeoutMs, 5);
    tools.finalizeApprovalExecution({
      approvalId: timeoutApprovalId,
      reviewer: 'test',
      operationId: timeoutClaim.operationId,
      executorId: timeoutClaim.executorId,
      args: timeoutClaim.args,
      result: {
        content: [{ type: 'text', text: 'Timed out after 5ms; cancellation was requested but the operation may still be running' }],
        isError: true,
        code: 'timed_out_operation_may_continue',
        operationMayContinue: true,
        operationId: timeoutClaim.operationId,
        idempotencyKey: timeoutClaim.idempotencyKey,
      },
    });
    const timeoutStored = db.loadDocument('approvals', []).find(item => item.id === timeoutApprovalId);
    assert.strictEqual(timeoutStored.status, 'reconciliation_required');
    assert.strictEqual(timeoutStored.reconciliation_status, 'manual_review');
    assert.strictEqual(timeoutStored.operation_id, timeoutClaim.operationId);

    result = await tools.callTool('sidekick_respond', { text: 'stale low' }, { source: 'mcp' });
    const staleLowId = result.approvalId;
    tools.claimApprovalExecution({ approvalId: staleLowId, reviewer: 'test' });
    staleApprovals = db.loadDocument('approvals', []);
    const staleLow = staleApprovals.find(item => item.id === staleLowId);
    staleLow.risk = 'low';
    staleLow.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    db.setDocument('approvals', staleApprovals);
    const recovered = tools.recoverStaleApprovals({ allowLowRiskRetry: true });
    assert.ok(recovered.some(item => item.id === staleLowId));
    assert.strictEqual(db.loadDocument('approvals', []).find(item => item.id === staleLowId).status, 'pending');
    result = await tools.resolveApproval(staleLowId, 'reject', 'test');
    assert.strictEqual(result.isError, undefined);
    console.log('Passed\n');

    console.log('Test 4: exempt tool bypasses approval');
    process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = 'sidekick_respond';
    result = await tools.callTool('sidekick_respond', { text: 'exempt' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'exempt');
    assert.strictEqual(tools.listApprovals({ status: 'pending' }).length, 0);
    console.log('Passed\n');

    console.log('Test 5: current policy is enforced when an approval runs');
    process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = '';
    result = await tools.callTool('sidekick_respond', { text: 'must stay blocked' });
    const blockedApprovalId = result.approvalId;
    process.env.SIDEKICK_BLOCKED_TOOLS = 'sidekick_respond';
    result = await tools.resolveApproval(blockedApprovalId, 'approve', 'test');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Tool blocked by policy'));
    const blockedApproval = db.loadDocument('approvals', []).find(item => item.id === blockedApprovalId);
    assert.strictEqual(blockedApproval.status, 'failed');
    const blockedExecution = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(blockedApproval.platform_execution_id);
    assert.strictEqual(blockedExecution.state, 'failed');
    assert.strictEqual(blockedExecution.result_status, 'failure');
    process.env.SIDEKICK_BLOCKED_TOOLS = '';
    console.log('Passed\n');

    console.log('Test 6: expired approvals cannot execute and discard payloads');
    result = await tools.callTool('sidekick_respond', { text: 'expired request' });
    const expiredApprovalId = result.approvalId;
    const storedApprovals = db.loadDocument('approvals', []);
    const expiring = storedApprovals.find(item => item.id === expiredApprovalId);
    expiring.expires_at = new Date(Date.now() - 1000).toISOString();
    db.setDocument('approvals', storedApprovals);
    assert.strictEqual(tools.listApprovals({ status: 'expired' }).length, 1);
    const expiredStored = db.loadDocument('approvals', []).find(item => item.id === expiredApprovalId);
    assert.ok(!Object.prototype.hasOwnProperty.call(expiredStored, 'args_encrypted'));
    const expiredExecution = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(expiredStored.platform_execution_id);
    assert.strictEqual(expiredExecution.state, 'timed_out');
    assert.strictEqual(expiredExecution.result_status, 'expired');
    result = await tools.resolveApproval(expiredApprovalId, 'approve', 'test');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already expired'));
    console.log('Passed\n');

    console.log('Test 7: missing encryption key fails closed');
    delete process.env.SIDEKICK_SECRET_KEY;
    result = await tools.callTool('sidekick_respond', { text: 'do not persist' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Approval queue unavailable'));
    assert.strictEqual(tools.listApprovals({ status: 'pending' }).length, 0);
    console.log('Passed\n');

    console.log('Test 8: legacy plaintext pending payloads are encrypted on access');
    process.env.SIDEKICK_SECRET_KEY = 'approval-test-secret-key';
    const legacyApprovals = db.loadDocument('approvals', []);
    legacyApprovals.unshift({
      id: 'approval_legacy_test',
      status: 'pending',
      tool: 'sidekick_respond',
      risk: 'low',
      source: 'mcp',
      mode: 'risky',
      reason: 'legacy test',
      args: { text: 'legacy queued', password: 'legacy-secret' },
      args_preview: '{ "password": "[REDACTED]" }',
      requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    db.setDocument('approvals', legacyApprovals);
    assert.strictEqual(tools.listApprovals({ status: 'pending' }).length, 1);
    const migratedLegacy = db.loadDocument('approvals', []).find(item => item.id === 'approval_legacy_test');
    assert.ok(migratedLegacy.args_encrypted);
    assert.ok(!Object.prototype.hasOwnProperty.call(migratedLegacy, 'args'));
    result = await tools.resolveApproval('approval_legacy_test', 'approve', 'test');
    assert.strictEqual(result.content[0].text, 'legacy queued');
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Approval Tests Passed!');
  } catch (e) {
    console.error('Approval test failed:', e);
    process.exit(1);
  }
})();
