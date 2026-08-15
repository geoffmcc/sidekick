// Queue durability honesty: the queue is file-backed with IN-PROCESS
// execution, so a task caught in "processing" when the process dies used to be
// poisoned forever (process only picks "pending"). `recover` resets stuck
// tasks to pending with an audit note, and `process` runs that recovery
// opportunistically first.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-queue-recover-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_TOOL_POLICY = 'open';

delete require.cache[require.resolve('../src/tools')];
delete require.cache[require.resolve('../src/db')];
const tools = require('../src/tools');

const { TOOLS } = tools;
const QUEUE_FILE = path.join(TEST_DATA_DIR, 'queue.json');

function readQueue() {
  return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
}
function writeQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

console.log('Running Queue Recover Tests...\n');

(async () => {
  try {
    tools.setSource('mcp');

    console.log('Test QR.1: the queue descriptor no longer overstates its durability');
    const descriptor = tools.getBuiltinRegistry().get('queue');
    assert.ok(!/^Persistent task queue with priorities$/.test(descriptor.description), 'old description replaced');
    assert.ok(/file-backed/i.test(descriptor.description), 'description states file-backed persistence');
    assert.ok(/in-process/i.test(descriptor.description), 'description states in-process execution');
    assert.ok(/recover/i.test(descriptor.description), 'description points at recover');
    console.log('Passed\n');

    console.log('Test QR.2: recover re-queues a task stuck in processing past the threshold, with an audit note');
    let result = await TOOLS.queue({ action: 'add', tool: 'respond', args: { text: 'queued-ok' } });
    assert.strictEqual(result.isError, undefined);
    // Simulate an interrupted run: mark the task processing 30 minutes ago.
    let queue = readQueue();
    queue.tasks[0].status = 'processing';
    queue.tasks[0].attempts = 1;
    queue.tasks[0].startedAt = new Date(Date.now() - 30 * 60000).toISOString();
    writeQueue(queue);

    result = await TOOLS.queue({ action: 'recover' });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Recovered 1'));
    queue = readQueue();
    assert.strictEqual(queue.tasks[0].status, 'pending');
    assert.strictEqual(queue.tasks[0].attempts, 1, 'attempts history preserved');
    assert.ok(Array.isArray(queue.tasks[0].recoveries) && queue.tasks[0].recoveries.length === 1, 'audit note recorded on the task');
    assert.ok(queue.tasks[0].recoveries[0].note.includes('stuck in processing'));
    console.log('Passed\n');

    console.log('Test QR.3: recover leaves fresh processing tasks alone (default 10m threshold)');
    queue = readQueue();
    queue.tasks[0].status = 'processing';
    queue.tasks[0].startedAt = new Date(Date.now() - 60000).toISOString(); // 1 minute
    writeQueue(queue);
    result = await TOOLS.queue({ action: 'recover' });
    assert.ok(result.content[0].text.includes('No tasks stuck'));
    assert.strictEqual(readQueue().tasks[0].status, 'processing');
    // ... but an explicit lower threshold recovers it.
    result = await TOOLS.queue({ action: 'recover', older_than_minutes: 0.01 });
    assert.ok(result.content[0].text.includes('Recovered 1'));
    assert.strictEqual(readQueue().tasks[0].status, 'pending');
    console.log('Passed\n');

    console.log('Test QR.4: process opportunistically recovers a poisoned slot, then executes it');
    queue = readQueue();
    queue.tasks[0].status = 'processing';
    queue.tasks[0].startedAt = new Date(Date.now() - 30 * 60000).toISOString();
    writeQueue(queue);
    result = await TOOLS.queue({ action: 'process' });
    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    assert.ok(result.content[0].text.includes('queued-ok'), 'the recovered task actually ran');
    queue = readQueue();
    assert.strictEqual(queue.tasks[0].status, 'completed');
    assert.ok(queue.tasks[0].recoveries.length >= 2, 'the opportunistic recovery also left an audit note');
    console.log('Passed\n');

    console.log('Test QR.5: a legacy processing row without startedAt falls back to created and is recoverable');
    queue = readQueue();
    queue.tasks.push({ id: 999, tool: 'respond', args: { text: 'legacy' }, priority: 0, status: 'processing', created: new Date(Date.now() - 60 * 60000).toISOString(), attempts: 1 });
    writeQueue(queue);
    result = await TOOLS.queue({ action: 'recover' });
    assert.ok(result.content[0].text.includes('999'));
    assert.strictEqual(readQueue().tasks.find(t => t.id === 999).status, 'pending');
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Queue Recover Tests Passed!');
  } catch (e) {
    console.error('Queue recover test failed:', e);
    process.exit(1);
  }
})();
