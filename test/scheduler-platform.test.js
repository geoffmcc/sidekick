const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-scheduler-platform-data');
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
    let result = await TOOLS.sidekick_cron({ action: 'add', name: 'platform cron', schedule: '* * * * *', command: 'printf cron-ok' });
    assert.strictEqual(result.isError, undefined);
    const cronJob = db.loadDocument('cron', [])[0];
    assert.ok(cronJob.platform_execution_id);
    let cronDefinition = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(cronJob.platform_execution_id);
    assert.strictEqual(cronDefinition.operation_type, 'cron_job');
    assert.strictEqual(cronDefinition.state, 'queued');
    result = await TOOLS.sidekick_cron({ action: 'run', id: cronJob.id });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('cron-ok'));
    const cronRun = latestExecution("operation_type = 'cron_run'");
    assert.strictEqual(cronRun.state, 'completed');
    assert.strictEqual(cronRun.result_status, 'success');
    console.log('Passed\n');

    console.log('Test SP.2: delay add/run mirrors lifecycle and child tool execution');
    result = await TOOLS.sidekick_delay({ action: 'add', when: '1h', name: 'platform delay', tool: 'sidekick_respond', args: { text: 'delay-ok' } });
    assert.strictEqual(result.isError, undefined);
    const delay = tools.loadDelays()[0];
    assert.ok(delay.platform_execution_id);
    let delayExecution = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(delay.platform_execution_id);
    assert.strictEqual(delayExecution.operation_type, 'delay_task');
    assert.strictEqual(delayExecution.state, 'queued');
    result = await TOOLS.sidekick_delay({ action: 'run', id: delay.id });
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
    result = await TOOLS.sidekick_watch({ action: 'add', name: 'platform watch', source: 'file', target: watchedFile, condition: 'exists', action_tool: 'sidekick_respond', action_args: { text: 'watch-ok' } });
    assert.strictEqual(result.isError, undefined);
    const watch = tools.loadWatches()[0];
    assert.ok(watch.platform_execution_id);
    const watchMonitor = db.getDb().prepare('SELECT * FROM platform_executions WHERE execution_id = ?').get(watch.platform_execution_id);
    assert.strictEqual(watchMonitor.operation_type, 'watch_monitor');
    assert.strictEqual(watchMonitor.state, 'queued');
    result = await TOOLS.sidekick_watch({ action: 'check', id: watch.id });
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
    result = await TOOLS.sidekick_runbook({ action: 'create', name: 'platform runbook', steps: [{ name: 'say ok', command: 'printf runbook-ok' }] });
    assert.strictEqual(result.isError, undefined);
    const runbookId = result.content[0].text.match(/Runbook created: (\S+)/)[1];
    result = await TOOLS.sidekick_runbook({ action: 'start', runbook_id: runbookId, mode: 'autonomous' });
    assert.strictEqual(result.isError, undefined);
    const runbookExecution = latestExecution("operation_type = 'runbook_execution'");
    assert.strictEqual(runbookExecution.state, 'completed');
    assert.strictEqual(runbookExecution.result_status, 'success');
    const stepEvent = db.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'runbook.step_completed' AND execution_id = ?").get(runbookExecution.execution_id);
    assert.ok(stepEvent);
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Scheduler Platform Tests Passed!');
  } catch (e) {
    console.error('Scheduler platform test failed:', e);
    process.exit(1);
  }
})();
