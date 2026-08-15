// Cron/watch cancel writers (item: cancel path completion). delay cancel and
// runbook abort already request execution cancellation when a live claim
// exists; cron remove and watch remove/pause now follow the same contract so
// an in-flight claimed execution receives a cancel request instead of having
// its definition transitioned/removed out from under the claimant. Direct
// removal/pause behavior is preserved when no live claim exists.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-scheduling-cancel-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_TOOL_POLICY = 'open';

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];
const tools = require('../src/tools');
const db = require('../src/db');
const platformKernel = require('../src/platform/kernel');

const { TOOLS } = tools;

function claimOf(executionId) {
  return platformKernel.getExecutionClaim(executionId);
}

console.log('Running Scheduling Cancel Tests...\n');

(async () => {
  try {
    tools.setSource('mcp');

    console.log('Test SC.1: cron remove with a live claim requests cancel and keeps the definition');
    let result = await TOOLS.cron({ action: 'add', name: 'cancel cron', schedule: '* * * * *', command: 'printf x' });
    assert.strictEqual(result.isError, undefined);
    const cronJob = db.loadDocument('cron', [])[0];
    assert.ok(cronJob.platform_execution_id);
    const cronClaim = platformKernel.claimExecution({ execution_id: cronJob.platform_execution_id, claimed_by: 'test-runner-cron' });
    assert.strictEqual(cronClaim.ok, true);

    result = await TOOLS.cron({ action: 'remove', id: cronJob.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Cancellation requested'), result.content[0].text);
    assert.strictEqual(db.loadDocument('cron', []).length, 1, 'definition retained while the claimant is live');
    assert.strictEqual(claimOf(cronJob.platform_execution_id).cancel_requested, true, 'cancel_requested set on the claim');
    const cancelEvent = db.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'execution.cancel_requested' AND execution_id = ?").get(cronJob.platform_execution_id);
    assert.ok(cancelEvent, 'cancel request is on the event ledger');
    console.log('Passed\n');

    console.log('Test SC.2: cron remove without a live claim removes directly (existing behavior)');
    platformKernel.releaseExecutionClaim({ execution_id: cronJob.platform_execution_id, claimed_by: 'test-runner-cron', claim_epoch: cronClaim.claim.claim_epoch });
    result = await TOOLS.cron({ action: 'remove', id: cronJob.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Removed job'));
    assert.strictEqual(db.loadDocument('cron', []).length, 0);
    console.log('Passed\n');

    console.log('Test SC.3: watch remove with a live claim requests cancel and keeps the watch');
    const watchedFile = path.join(TEST_DATA_DIR, 'watched.txt');
    fs.writeFileSync(watchedFile, 'x', 'utf-8');
    result = await TOOLS.watch({ action: 'add', name: 'cancel watch', source: 'file', target: watchedFile, condition: 'exists', action_tool: 'respond', action_args: { text: 'w' } });
    assert.strictEqual(result.isError, undefined);
    const watch = tools.loadWatches()[0];
    assert.ok(watch.platform_execution_id);
    const watchClaim = platformKernel.claimExecution({ execution_id: watch.platform_execution_id, claimed_by: 'test-runner-watch' });
    assert.strictEqual(watchClaim.ok, true);

    result = await TOOLS.watch({ action: 'remove', id: watch.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Cancellation requested'), result.content[0].text);
    assert.strictEqual(tools.loadWatches().length, 1, 'watch retained while the claimant is live');
    assert.strictEqual(claimOf(watch.platform_execution_id).cancel_requested, true);
    console.log('Passed\n');

    console.log('Test SC.4: watch pause (disable) with a live claim requests cancel instead of writing under the lease');
    // Reuse the same live claim: pause=true must not transition the definition.
    result = await TOOLS.watch({ action: 'pause', id: watch.id, pause: true });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Cancellation requested'), result.content[0].text);
    assert.strictEqual(tools.loadWatches()[0].status, 'active', 'the claimant, not this writer, pauses the watch');
    console.log('Passed\n');

    console.log('Test SC.5: watch pause/remove without a live claim keep the direct path');
    platformKernel.releaseExecutionClaim({ execution_id: watch.platform_execution_id, claimed_by: 'test-runner-watch', claim_epoch: watchClaim.claim.claim_epoch });
    // Note: cancel_requested stays set on the claim row (that is the watch
    // cancel contract — a future claimant re-pauses), but with no LIVE claim
    // the operator's direct pause/remove proceeds.
    result = await TOOLS.watch({ action: 'pause', id: watch.id, pause: true });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Paused watch'));
    assert.strictEqual(tools.loadWatches()[0].status, 'paused');
    result = await TOOLS.watch({ action: 'remove', id: watch.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Removed watch'));
    assert.strictEqual(tools.loadWatches().length, 0);
    console.log('Passed\n');

    console.log('Test SC.6: resume (pause=false) never routes through the cancel path');
    result = await TOOLS.watch({ action: 'add', name: 'resume watch', source: 'file', target: watchedFile, condition: 'exists' });
    assert.strictEqual(result.isError, undefined);
    const watch2 = tools.loadWatches()[0];
    await TOOLS.watch({ action: 'pause', id: watch2.id, pause: true });
    const resumeClaim = platformKernel.claimExecution({ execution_id: watch2.platform_execution_id, claimed_by: 'test-runner-watch2' });
    assert.strictEqual(resumeClaim.ok, true);
    result = await TOOLS.watch({ action: 'pause', id: watch2.id, pause: false });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Resumed watch'));
    assert.strictEqual(tools.loadWatches()[0].status, 'active');
    assert.strictEqual(claimOf(watch2.platform_execution_id).cancel_requested, false, 'resume requested no cancel');
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Scheduling Cancel Tests Passed!');
  } catch (e) {
    console.error('Scheduling cancel test failed:', e);
    process.exit(1);
  }
})();
