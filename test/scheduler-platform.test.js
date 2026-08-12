const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-scheduler-platform-data');
const RB_FILE = path.join(TEST_DATA_DIR, 'runbooks.json');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_TOOL_POLICY = 'open';

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];
const tools = require('../src/tools');
const db = require('../src/db');

const { TOOLS } = tools;

function latestExecution(whereSql, params = []) {
  return db.getDb().prepare(`
    SELECT * FROM platform_executions
    WHERE ${whereSql}
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(...params);
}

console.log('Running Scheduler Platform Tests...\n');

(async () => {
  try {
    tools.setSource('mcp');

    console.log('Test SP.1: cron add/run mirrors platform executions');
    let result = await TOOLS.cron({ action: 'add', name: 'platform cron', schedule: '* * * * *', command: 'printf cron-ok' });
    assert.strictEqual(result.isError, undefined);
    const cronJob = db.loadDocument('cron', [])[0];
    assert.ok(cronJob.platform_execution_id);
    let cronDefinition = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(cronJob.platform_execution_id);
    assert.strictEqual(cronDefinition.operation_type, 'cron_job');
    assert.strictEqual(cronDefinition.state, 'queued');
    result = await TOOLS.cron({ action: 'run', id: cronJob.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('cron-ok'));
    const cronRun = latestExecution("operation_type = 'cron_run'");
    assert.strictEqual(cronRun.state, 'completed');
    assert.strictEqual(cronRun.result_status, 'success');
    console.log('Passed\n');

    console.log('Test SP.2: delay add/run mirrors lifecycle and child tool execution');
    result = await TOOLS.delay({ action: 'add', when: '1h', name: 'platform delay', tool: 'sidekick_respond', args: { text: 'delay-ok' } });
    assert.strictEqual(result.isError, undefined);
    const delay = tools.loadDelays()[0];
    assert.ok(delay.platform_execution_id);
    let delayExecution = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(delay.platform_execution_id);
    assert.strictEqual(delayExecution.operation_type, 'delay_task');
    assert.strictEqual(delayExecution.state, 'queued');
    result = await TOOLS.delay({ action: 'run', id: delay.id });
    assert.strictEqual(result.isError, undefined);
    delayExecution = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(delay.platform_execution_id);
    assert.strictEqual(delayExecution.state, 'completed');
    assert.strictEqual(delayExecution.result_status, 'success');
    const delayChild = latestExecution("parent_execution_id = ? AND operation_type = 'tool_call'", [delay.platform_execution_id]);
    assert.ok(delayChild);
    assert.strictEqual(delayChild.tool_name, 'sidekick_respond');
    console.log('Passed\n');

    console.log('Test SP.3: watch add/check mirrors monitor and check execution');
    const watchedFile = path.join(TEST_DATA_DIR, 'watched.txt');
    fs.writeFileSync(watchedFile, 'trigger me', 'utf-8');
    result = await TOOLS.watch({ action: 'add', name: 'platform watch', source: 'file', target: watchedFile, condition: 'exists', action_tool: 'sidekick_respond', action_args: { text: 'watch-ok' } });
    assert.strictEqual(result.isError, undefined);
    const watch = tools.loadWatches()[0];
    assert.ok(watch.platform_execution_id);
    const watchMonitor = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(watch.platform_execution_id);
    assert.strictEqual(watchMonitor.operation_type, 'watch_monitor');
    assert.strictEqual(watchMonitor.state, 'queued');
    result = await TOOLS.watch({ action: 'check', id: watch.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Triggered: true'));
    const watchCheck = latestExecution("parent_execution_id = ? AND operation_type = 'watch_check'", [watch.platform_execution_id]);
    assert.ok(watchCheck);
    assert.strictEqual(watchCheck.state, 'completed');
    assert.strictEqual(watchCheck.result_status, 'success');
    const triggeredEvent = db.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'schedule.watch.triggered' AND subject_id = ?").get(watch.id);
    assert.ok(triggeredEvent);
    console.log('Passed\n');

    console.log('Test SP.4: runbook start mirrors execution and step events');
    result = await TOOLS.runbook({ action: 'create', name: 'platform runbook', steps: [{ name: 'say ok', command: 'printf runbook-ok' }] });
    assert.strictEqual(result.isError, undefined);
    const runbookId = result.content[0].text.match(/Runbook created: (\S+)/)[1];
    result = await TOOLS.runbook({ action: 'start', runbook_id: runbookId, mode: 'autonomous' });
    assert.strictEqual(result.isError, undefined);
    const platformKernel = require('../src/platform/kernel');
    const runbookExecution = latestExecution("operation_type = 'runbook_execution'");
    assert.strictEqual(runbookExecution.state, 'completed');
    assert.strictEqual(runbookExecution.result_status, 'success');
    assert.deepStrictEqual(platformKernel.getExecutionClaim(runbookExecution.execution_id).checkpoint, {
      cursor: 'runbook_step', completed_step: 0, next_step: 1, total_steps: 1,
    });
    const stepEvent = db.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'runbook.step_completed' AND execution_id = ?").get(runbookExecution.execution_id);
    assert.ok(stepEvent);
    console.log('Passed\n');

    console.log('Test SP.4b: guided runbook status mirrors the execution ledger');
    result = await TOOLS.runbook({ action: 'create', name: 'ledger-authority runbook', steps: [
      { name: 'first guided step', command: 'printf first-guided' },
      { name: 'second guided step', command: 'printf second-guided' },
    ] });
    assert.strictEqual(result.isError, undefined);
    const ledgerAuthorityRbId = result.content[0].text.match(/Runbook created: (\S+)/)[1];
    result = await TOOLS.runbook({ action: 'start', runbook_id: ledgerAuthorityRbId, mode: 'guided' });
    assert.strictEqual(result.isError, undefined);
    let ledgerAuthorityData = JSON.parse(fs.readFileSync(RB_FILE, 'utf8'));
    let ledgerAuthorityInstance = Object.values(ledgerAuthorityData.instances).find(i => i.definitionId === ledgerAuthorityRbId);
    let ledgerAuthorityExecution = db.getDb().prepare('SELECT state FROM platform_executions WHERE execution_id = ?').get(ledgerAuthorityInstance.platform_execution_id);
    assert.strictEqual(ledgerAuthorityExecution.state, 'waiting');
    assert.strictEqual(ledgerAuthorityInstance.status, 'waiting');
    assert.deepStrictEqual(platformKernel.getExecutionClaim(ledgerAuthorityInstance.platform_execution_id).checkpoint, {
      cursor: 'runbook_step', completed_step: 0, next_step: 1, total_steps: 2,
    });

    ledgerAuthorityInstance.status = 'running';
    fs.writeFileSync(RB_FILE, JSON.stringify(ledgerAuthorityData, null, 2));
    result = await TOOLS.runbook({ action: 'next', runbook_id: ledgerAuthorityInstance.id });
    assert.strictEqual(result.isError, undefined);
    ledgerAuthorityData = JSON.parse(fs.readFileSync(RB_FILE, 'utf8'));
    ledgerAuthorityInstance = ledgerAuthorityData.instances[ledgerAuthorityInstance.id];
    assert.strictEqual(ledgerAuthorityInstance.status, 'completed');
    assert.strictEqual(db.getDb().prepare('SELECT state FROM platform_executions WHERE execution_id = ?').get(ledgerAuthorityInstance.platform_execution_id).state, 'completed');
    console.log('Passed\n');

    console.log('Test SP.4c: next refuses a ledger-terminalized guided runbook');
    result = await TOOLS.runbook({ action: 'create', name: 'ledger-terminal runbook', steps: [
      { name: 'terminal first', command: 'printf terminal-first' },
      { name: 'terminal second', command: 'printf terminal-second' },
    ] });
    assert.strictEqual(result.isError, undefined);
    const ledgerTerminalRbId = result.content[0].text.match(/Runbook created: (\S+)/)[1];
    result = await TOOLS.runbook({ action: 'start', runbook_id: ledgerTerminalRbId, mode: 'guided' });
    assert.strictEqual(result.isError, undefined);
    const ledgerTerminalInstance = Object.values(JSON.parse(fs.readFileSync(RB_FILE, 'utf8')).instances).find(i => i.definitionId === ledgerTerminalRbId);
    platformKernel.transitionExecution(ledgerTerminalInstance.platform_execution_id, 'cancelled', { source: 'test', reason: 'ledger terminalization' });
    const terminalData = JSON.parse(fs.readFileSync(RB_FILE, 'utf8'));
    terminalData.instances[ledgerTerminalInstance.id].status = 'running';
    fs.writeFileSync(RB_FILE, JSON.stringify(terminalData, null, 2));
    result = await TOOLS.runbook({ action: 'next', runbook_id: ledgerTerminalInstance.id });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('ledger state cancelled'));
    assert.strictEqual(JSON.parse(fs.readFileSync(RB_FILE, 'utf8')).instances[ledgerTerminalInstance.id].status, 'cancelled');
    console.log('Passed\n');

    console.log('Test SP.5: delay run backs off when the execution is claimed');
    result = await TOOLS.delay({ action: 'add', when: '1h', name: 'claimed delay', tool: 'sidekick_respond', args: { text: 'delay-claim' } });
    assert.strictEqual(result.isError, undefined);
    const claimedDelay = tools.loadDelays().find(d => d.name === 'claimed delay');
    const held = platformKernel.claimExecution({ execution_id: claimedDelay.platform_execution_id, claimed_by: 'other-runner' });
    assert.strictEqual(held.ok, true);
    result = await TOOLS.delay({ action: 'run', id: claimedDelay.id });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('already being executed'));
    assert.strictEqual(tools.loadDelays().find(d => d.id === claimedDelay.id).status, 'pending');
    assert.strictEqual(platformKernel.releaseExecutionClaim({ execution_id: claimedDelay.platform_execution_id, claimed_by: 'other-runner', claim_epoch: held.claim.claim_epoch }).ok, true);
    console.log('Passed\n');

    console.log('Test SP.6: cancel request stops a delay before dispatch as an outcome, not a failure');
    result = await TOOLS.delay({ action: 'add', when: '1h', name: 'cancel delay', tool: 'sidekick_respond', args: { text: 'never-runs' } });
    assert.strictEqual(result.isError, undefined);
    const cancelDelay = tools.loadDelays().find(d => d.name === 'cancel delay');
    platformKernel.requestExecutionCancel(cancelDelay.platform_execution_id, { reason: 'operator cancel' });
    result = await TOOLS.delay({ action: 'run', id: cancelDelay.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('cancelled before dispatch'));
    assert.strictEqual(tools.loadDelays().find(d => d.id === cancelDelay.id).status, 'cancelled');
    const cancelExec = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(cancelDelay.platform_execution_id);
    assert.strictEqual(cancelExec.state, 'cancelled');
    assert.strictEqual(cancelExec.result_status, 'cancelled');
    const noChild = latestExecution("parent_execution_id = ? AND operation_type = 'tool_call'", [cancelDelay.platform_execution_id]);
    assert.strictEqual(noChild, undefined);
    console.log('Passed\n');

    console.log('Test SP.6b: delay cancel requests cooperatively when a runner owns the claim');
    result = await TOOLS.delay({ action: 'add', when: '1h', name: 'live cancel delay', tool: 'sidekick_respond', args: { text: 'in-flight' } });
    assert.strictEqual(result.isError, undefined);
    const liveCancelDelay = tools.loadDelays().find(d => d.name === 'live cancel delay');
    const liveDelayClaim = platformKernel.claimExecution({ execution_id: liveCancelDelay.platform_execution_id, claimed_by: 'live-delay-runner' });
    assert.strictEqual(liveDelayClaim.ok, true);
    result = await TOOLS.delay({ action: 'cancel', id: liveCancelDelay.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Cancellation requested'));
    assert.strictEqual(tools.loadDelays().find(d => d.id === liveCancelDelay.id).status, 'pending');
    const liveDelayExec = db.getDb().prepare('SELECT actor_id FROM platform_execution_events WHERE event_type = ? AND execution_id = ? ORDER BY rowid DESC LIMIT 1').get('execution.cancel_requested', liveCancelDelay.platform_execution_id);
    assert.strictEqual(liveDelayExec.actor_id, 'mcp');
    assert.strictEqual(platformKernel.releaseExecutionClaim({ execution_id: liveCancelDelay.platform_execution_id, claimed_by: 'live-delay-runner', claim_epoch: liveDelayClaim.claim.claim_epoch }).ok, true);
    console.log('Passed\n');

    console.log('Test SP.6c: runbook abort requests cooperatively when a runner owns the claim');
    result = await TOOLS.runbook({ action: 'create', name: 'live abort runbook', steps: [{ name: 'first', command: 'printf first' }, { name: 'later', command: 'printf later' }] });
    assert.strictEqual(result.isError, undefined);
    const liveAbortRbId = result.content[0].text.match(/Runbook created: (\S+)/)[1];
    result = await TOOLS.runbook({ action: 'start', runbook_id: liveAbortRbId, mode: 'guided' });
    assert.strictEqual(result.isError, undefined);
    const liveAbortInstance = Object.values(JSON.parse(fs.readFileSync(RB_FILE, 'utf8')).instances).find(i => i.definitionId === liveAbortRbId);
    const liveAbortClaim = platformKernel.claimExecution({ execution_id: liveAbortInstance.platform_execution_id, claimed_by: 'live-runbook-runner' });
    assert.strictEqual(liveAbortClaim.ok, true);
    result = await TOOLS.runbook({ action: 'abort', runbook_id: liveAbortInstance.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Abort requested'));
    const liveAbortAfter = JSON.parse(fs.readFileSync(RB_FILE, 'utf8')).instances[liveAbortInstance.id];
    assert.notStrictEqual(liveAbortAfter.status, 'aborted');
    const liveAbortEvent = db.getDb().prepare('SELECT actor_id FROM platform_execution_events WHERE event_type = ? AND execution_id = ? ORDER BY rowid DESC LIMIT 1').get('execution.cancel_requested', liveAbortInstance.platform_execution_id);
    assert.strictEqual(liveAbortEvent.actor_id, 'mcp');
    assert.strictEqual(platformKernel.releaseExecutionClaim({ execution_id: liveAbortInstance.platform_execution_id, claimed_by: 'live-runbook-runner', claim_epoch: liveAbortClaim.claim.claim_epoch }).ok, true);
    console.log('Passed\n');

    console.log('Test SP.7: a delay stranded running by a crash is re-queued on recovery');
    result = await TOOLS.delay({ action: 'add', when: '1h', name: 'stranded delay', tool: 'sidekick_respond', args: { text: 'later' } });
    assert.strictEqual(result.isError, undefined);
    const stranded = tools.loadDelays().find(d => d.name === 'stranded delay');
    assert.strictEqual(platformKernel.claimExecution({ execution_id: stranded.platform_execution_id, claimed_by: 'dead-runner' }).ok, true);
    platformKernel.transitionExecution(stranded.platform_execution_id, 'running', { source: 'test', reason: 'simulate crash mid-run' });
    const delaysNow = tools.loadDelays();
    delaysNow.find(d => d.id === stranded.id).status = 'running';
    tools.saveDelays(delaysNow);
    db.getDb().prepare('UPDATE platform_execution_claims SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(Date.now() - 60000).toISOString(), stranded.platform_execution_id);
    const recovery = tools.recoverStrandedDelays({ source: 'test' });
    assert.strictEqual(recovery.requeued, 1);
    assert.strictEqual(tools.loadDelays().find(d => d.id === stranded.id).status, 'pending');
    const recoveredExec = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(stranded.platform_execution_id);
    assert.strictEqual(recoveredExec.state, 'queued');
    const rerun = tools.recoverStrandedDelays({ source: 'test' });
    assert.strictEqual(rerun.requeued, 0);
    console.log('Passed\n');

    console.log('Test SP.8: delay run fails closed when the execution is terminal');
    result = await TOOLS.delay({ action: 'add', when: '1h', name: 'terminal delay', tool: 'sidekick_respond', args: { text: 'never' } });
    assert.strictEqual(result.isError, undefined);
    const terminalDelay = tools.loadDelays().find(d => d.name === 'terminal delay');
    platformKernel.transitionExecution(terminalDelay.platform_execution_id, 'cancelled', { source: 'test', reason: 'ledger cancelled out of band' });
    result = await TOOLS.delay({ action: 'run', id: terminalDelay.id });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('execution_terminal'));
    assert.strictEqual(tools.loadDelays().find(d => d.id === terminalDelay.id).status, 'pending');
    const noDispatch = latestExecution("parent_execution_id = ? AND operation_type = 'tool_call'", [terminalDelay.platform_execution_id]);
    assert.strictEqual(noDispatch, undefined);
    console.log('Passed\n');

    console.log('Test SP.9: watch check backs off while another runner holds the claim');
    result = await TOOLS.watch({ action: 'add', name: 'claimed watch', source: 'file', target: __filename, condition: 'exists', interval: '1h', action_tool: 'sidekick_respond', action_args: { text: 'watch-hit' } });
    assert.strictEqual(result.isError, undefined);
    const claimWatch = tools.loadWatches()[tools.loadWatches().length - 1];
    assert.ok(claimWatch.platform_execution_id);
    const watchHeld = platformKernel.claimExecution({ execution_id: claimWatch.platform_execution_id, claimed_by: 'other-checker' });
    assert.strictEqual(watchHeld.ok, true);
    result = await TOOLS.watch({ action: 'check', id: claimWatch.id });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('check already in progress'));
    assert.strictEqual(platformKernel.releaseExecutionClaim({ execution_id: claimWatch.platform_execution_id, claimed_by: 'other-checker', claim_epoch: watchHeld.claim.claim_epoch }).ok, true);
    result = await TOOLS.watch({ action: 'check', id: claimWatch.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Triggered: true'));
    assert.strictEqual(platformKernel.getExecutionClaim(claimWatch.platform_execution_id).claimed_by, null);
    console.log('Passed\n');

    console.log('Test SP.10: cancel request pauses the watch instead of checking');
    result = await TOOLS.watch({ action: 'add', name: 'cancel watch', source: 'file', target: __filename, condition: 'exists', interval: '1h', action_tool: 'sidekick_respond', action_args: { text: 'never' } });
    assert.strictEqual(result.isError, undefined);
    const cancelWatch = tools.loadWatches()[tools.loadWatches().length - 1];
    platformKernel.requestExecutionCancel(cancelWatch.platform_execution_id, { reason: 'operator stop' });
    result = await TOOLS.watch({ action: 'check', id: cancelWatch.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('paused'));
    assert.strictEqual(tools.loadWatches().find(w => w.id === cancelWatch.id).status, 'paused');
    const cancelWatchExec = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(cancelWatch.platform_execution_id);
    assert.strictEqual(cancelWatchExec.state, 'blocked');
    console.log('Passed\n');

    console.log('Test SP.11: a mid-check failure releases the watch claim');
    result = await TOOLS.watch({ action: 'add', name: 'throwing watch', source: 'file', target: __filename, condition: 'exists', interval: '1h', action_tool: 'sidekick_respond', action_args: { text: 'x' } });
    assert.strictEqual(result.isError, undefined);
    const throwWatch = tools.loadWatches()[tools.loadWatches().length - 1];
    const origTransition = platformKernel.transitionExecution;
    // Blanket throwing would be swallowed inside createScheduledPlatformExecution
    // and null the check execution; target the raw post-action transition only.
    platformKernel.transitionExecution = (execId, state, details = {}) => {
      if (details && typeof details.reason === 'string' && details.reason.startsWith('watch action')) throw new Error('injected transition failure');
      return origTransition(execId, state, details);
    };
    let checkOutcome = null;
    try {
      checkOutcome = await TOOLS.watch({ action: 'check', id: throwWatch.id });
    } catch (e) {
      checkOutcome = { threw: e.message };
    } finally {
      platformKernel.transitionExecution = origTransition;
    }
    assert.ok(checkOutcome);
    assert.strictEqual(platformKernel.getExecutionClaim(throwWatch.platform_execution_id).claimed_by, null);
    result = await TOOLS.watch({ action: 'check', id: throwWatch.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Triggered: true'));
    console.log('Passed\n');

    console.log('Test SP.12: stranded runbook instance is abandoned and frees its capacity slot');
    result = await TOOLS.runbook({ action: 'create', name: 'stranded runbook', steps: [{ name: 'ok', command: 'printf rb-ok' }] });
    assert.strictEqual(result.isError, undefined);
    const strandedRbId = result.content[0].text.match(/Runbook created: (\S+)/)[1];
    const strandedExec = platformKernel.createExecution({ operation_type: 'runbook_execution', source: 'test' });
    platformKernel.transitionExecution(strandedExec.execution_id, 'queued', { source: 'test', reason: 'test setup' });
    platformKernel.transitionExecution(strandedExec.execution_id, 'running', { source: 'test', reason: 'test setup' });
    const rbData = JSON.parse(fs.readFileSync(RB_FILE, 'utf8'));
    rbData.instances['rbi_stranded_test'] = { id: 'rbi_stranded_test', definitionId: strandedRbId, status: 'running', currentStep: 1, mode: 'autonomous', started: Date.now() - 31 * 60 * 1000, results: [], platform_execution_id: strandedExec.execution_id };
    fs.writeFileSync(RB_FILE, JSON.stringify(rbData, null, 2));
    const strandedClaim = platformKernel.claimExecution({ execution_id: strandedExec.execution_id, claimed_by: 'dead-rb-runner' });
    assert.strictEqual(strandedClaim.ok, true);
    assert.strictEqual(platformKernel.checkpointExecution({ execution_id: strandedExec.execution_id, claimed_by: 'dead-rb-runner', claim_epoch: strandedClaim.claim.claim_epoch, checkpoint: { cursor: 'runbook_step', completed_step: 2, next_step: 3, total_steps: 4 } }).ok, true);
    db.getDb().prepare('UPDATE platform_execution_claims SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(Date.now() - 60000).toISOString(), strandedExec.execution_id);
    platformKernel.recoverOrphanedExecutions({ source: 'test' });
    const rbRecovery = tools.recoverStrandedRunbooks({ source: 'test' });
    assert.strictEqual(rbRecovery.recovered, 1);
    assert.deepStrictEqual(rbRecovery.instances, ['rbi_stranded_test']);
    const rbDataAfter = JSON.parse(fs.readFileSync(RB_FILE, 'utf8'));
    assert.strictEqual(rbDataAfter.instances['rbi_stranded_test'].status, 'failed');
    assert.strictEqual(rbDataAfter.instances['rbi_stranded_test'].currentStep, 3);
    assert.strictEqual(rbDataAfter.instances['rbi_stranded_test'].abandoned, true);
    const strandedExecAfter = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(strandedExec.execution_id);
    assert.strictEqual(strandedExecAfter.state, 'failed');
    const rerunRecovery = tools.recoverStrandedRunbooks({ source: 'test' });
    assert.strictEqual(rerunRecovery.recovered, 0);
    console.log('Passed\n');

    console.log('Test SP.13: cron run backs off while the job execution is claimed');
    const cronJobForClaim = db.loadDocument('cron', [])[0];
    assert.ok(cronJobForClaim.platform_execution_id);
    const cronHeld = platformKernel.claimExecution({ execution_id: cronJobForClaim.platform_execution_id, claimed_by: 'other-cron-runner' });
    assert.strictEqual(cronHeld.ok, true);
    result = await TOOLS.cron({ action: 'run', id: cronJobForClaim.id });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('already running'));
    assert.strictEqual(platformKernel.releaseExecutionClaim({ execution_id: cronJobForClaim.platform_execution_id, claimed_by: 'other-cron-runner', claim_epoch: cronHeld.claim.claim_epoch }).ok, true);
    result = await TOOLS.cron({ action: 'run', id: cronJobForClaim.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('cron-ok'));
    assert.strictEqual(platformKernel.getExecutionClaim(cronJobForClaim.platform_execution_id).claimed_by, null);
    console.log('Passed\n');

    console.log('Test SP.14: cross-process cancel request stops an autonomous runbook at the next step boundary');
    // Step 1 requests the cancel from a separate node process (the real
    // cross-process topology: another service writing to the shared DB);
    // step 2 must never dispatch.
    const cancelScript = path.join(TEST_DATA_DIR, 'request-mid-run-cancel.js');
    const cancelMarker = path.join(TEST_DATA_DIR, 'cancelled-step-ran.txt');
    fs.writeFileSync(cancelScript, [
      `const kernel = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'platform', 'kernel'))});`,
      `const testDb = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db'))});`,
      "const row = testDb.getDb().prepare(\"SELECT execution_id FROM platform_executions WHERE operation_type = 'runbook_execution' AND state = 'running' ORDER BY updated_at DESC LIMIT 1\").get();",
      "kernel.requestExecutionCancel(row.execution_id, { source: 'test', reason: 'mid-run cancel' });",
    ].join('\n'));
    result = await TOOLS.runbook({ action: 'create', name: 'mid-run cancel runbook', steps: [
      { name: 'request cancel', command: `node ${JSON.stringify(cancelScript)}` },
      { name: 'never runs', command: `printf cancelled-step-ran > ${JSON.stringify(cancelMarker)}` },
    ] });
    assert.strictEqual(result.isError, undefined);
    const cancelRbId = result.content[0].text.match(/Runbook created: (\S+)/)[1];
    result = await TOOLS.runbook({ action: 'start', runbook_id: cancelRbId, mode: 'autonomous' });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Cancel requested'));
    assert.ok(!fs.existsSync(cancelMarker));
    const cancelledRun = latestExecution("operation_type = 'runbook_execution' AND state = 'cancelled'");
    assert.ok(cancelledRun);
    assert.strictEqual(cancelledRun.result_status, 'cancelled');
    assert.strictEqual(platformKernel.getExecutionClaim(cancelledRun.execution_id).claimed_by, null);
    const cancelledInstance = Object.values(JSON.parse(fs.readFileSync(RB_FILE, 'utf8')).instances).find(i => i.platform_execution_id === cancelledRun.execution_id);
    assert.strictEqual(cancelledInstance.status, 'cancelled');
    assert.strictEqual(cancelledInstance.currentStep, 1);
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Scheduler Platform Tests Passed!');
  } catch (e) {
    console.error('Scheduler platform test failed:', e);
    process.exit(1);
  }
})();
