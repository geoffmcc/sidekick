const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-platform-kernel');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/platform/kernel')];

const dbStore = require('../src/db');
const kernel = require('../src/platform/kernel');

console.log('Running Platform Kernel Tests...\n');

(async () => {
  try {
    console.log('Test PK.1: migration registers platform kernel tables');
    const migration = dbStore.runPendingMigrations();
    assert.ok(migration.applied >= 0, 'Migration runner should complete');
    const tables = dbStore.getTableList().map(t => t.name);
    assert.ok(tables.includes('platform_executions'), 'platform_executions should exist');
    assert.ok(tables.includes('platform_execution_events'), 'platform_execution_events should exist');
    assert.ok(tables.includes('platform_artifacts'), 'platform_artifacts should exist');
    console.log('Passed\n');

    console.log('Test PK.2: execution lifecycle validates transitions and emits events');
    const execution = kernel.createExecution({
      operation_type: 'tool_call',
      tool_name: 'sidekick_status',
      project_id: 'sidekick',
      actor_id: 'test_actor',
      client_id: 'test_client',
      trigger_type: 'test',
      resource_scope: 'local',
    });
    assert.strictEqual(execution.state, 'created', 'Execution should start created');
    const running = kernel.transitionExecution(execution.execution_id, 'running', { reason: 'test start' });
    assert.strictEqual(running.state, 'running', 'Execution should become running');
    const completed = kernel.transitionExecution(execution.execution_id, 'verifying', { reason: 'test verify' });
    assert.strictEqual(completed.state, 'verifying', 'Execution should become verifying');
    const terminal = kernel.transitionExecution(execution.execution_id, 'completed', { result_status: 'success', result_summary: 'verified' });
    assert.strictEqual(terminal.state, 'completed', 'Execution should complete');
    assert.throws(() => kernel.transitionExecution(execution.execution_id, 'running'), /Invalid execution transition/, 'Terminal states should not restart');
    const eventCount = dbStore.getDb().prepare('SELECT COUNT(*) AS count FROM platform_execution_events WHERE execution_id = ?').get(execution.execution_id).count;
    assert.ok(eventCount >= 4, 'Execution transitions should emit events');
    console.log('Passed\n');

    console.log('Test PK.3: event deduplication and artifact path safety');
    const first = kernel.appendEvent({ event_type: 'test.event', source: 'test', dedupe_key: 'same-key', payload: { ok: true } });
    const second = kernel.appendEvent({ event_type: 'test.event', source: 'test', dedupe_key: 'same-key', payload: { ok: false } });
    assert.strictEqual(first.event_id, second.event_id, 'Duplicate dedupe_key should return existing event');
    assert.throws(() => kernel.registerArtifact({ storage_ref: '../escape.txt', type: 'report', name: 'bad' }), /safe relative path/, 'Path traversal should be rejected');
    assert.throws(() => kernel.registerArtifact({ storage_ref: 'reports/bad.md', content_hash: 'sha256:test' }), /SHA-256 digest/, 'Artifact hashes should be real SHA-256 digests');
    const artifact = kernel.registerArtifact({
      execution_id: execution.execution_id,
      project_id: 'sidekick',
      type: 'report',
      name: 'assessment',
      storage_ref: 'reports/platform-assessment.md',
      content_type: 'text/markdown',
      content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    assert.strictEqual(artifact.storage_ref, 'reports/platform-assessment.md', 'Artifact metadata should be stored');
    const withArtifact = kernel.getExecution(execution.execution_id);
    assert.strictEqual(withArtifact.artifact_count, 1, 'Artifact count should be linked to execution');
    const derivative = kernel.registerArtifact({
      project_id: 'sidekick',
      type: 'report',
      name: 'assessment-redacted',
      storage_ref: 'reports/platform-assessment-redacted.md',
      content_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      supersedes_artifact_id: artifact.artifact_id,
      lineage: { purpose: 'redaction' },
      redaction_state: 'redacted',
    });
    assert.strictEqual(derivative.custody_role, 'derivative', 'Derived artifacts should expose custody role');
    assert.strictEqual(derivative.lineage.role, 'derivative', 'Derived artifacts should carry normalized lineage role');
    assert.strictEqual(kernel.listArtifacts({ custody_role: 'original' }).length, 1, 'Artifact listing should filter originals');
    assert.strictEqual(kernel.getArtifact(derivative.artifact_id).supersedes_artifact_id, artifact.artifact_id, 'Artifact lookup should preserve lineage');

    console.log('Test PK.4: event delivery retries, dead-letters, requeues, and advances offsets');
    const subscription = kernel.registerEventSubscription({ name: 'kernel-test-subscriber', event_type: 'delivery.test', max_attempts: 2 });
    const deliveryEvent = kernel.appendEvent({ event_type: 'delivery.test', source: 'test', payload: { value: 42 } });
    let deliveries = kernel.listEventDeliveries({ subscription_id: subscription.subscription_id });
    assert.strictEqual(deliveries.length, 1, 'Matching events should enqueue one delivery');
    const firstFailure = kernel.deliverEvent(deliveries[0].delivery_id, () => { throw new Error('temporary failure'); });
    assert.strictEqual(firstFailure.status, 'retry', 'First delivery failure should be retryable');
    dbStore.getDb().prepare("UPDATE platform_event_deliveries SET next_attempt_at = ? WHERE delivery_id = ?").run(new Date(0).toISOString(), firstFailure.delivery_id);
    const secondFailure = kernel.deliverEvent(firstFailure.delivery_id, () => { throw new Error('permanent failure'); });
    assert.strictEqual(secondFailure.status, 'dead_letter', 'Exhausted delivery attempts should dead-letter');
    const requeued = kernel.requeueEventDelivery(secondFailure.delivery_id);
    assert.strictEqual(requeued.status, 'pending', 'Dead-lettered deliveries should be explicitly requeueable');
    let received;
    const delivered = kernel.deliverEvent(requeued.delivery_id, event => { received = event.payload.value; });
    assert.strictEqual(delivered.status, 'delivered', 'Requeued delivery should succeed');
    assert.strictEqual(received, 42, 'Delivery handler should receive the decoded event payload');
    assert.strictEqual(dbStore.getDb().prepare("SELECT last_event_id FROM platform_event_offsets WHERE subscription_id = ?").get(subscription.subscription_id).last_event_id, deliveryEvent.event_id, 'Successful delivery should advance the consumer offset');
    assert.strictEqual(kernel.getEventDeliveryStats().dead_letter, 0, 'Requeued delivery should clear the dead-letter state');
    console.log('Passed\n');

    console.log('All Platform Kernel tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Platform Kernel test failed:', error);
    process.exit(1);
  }
})();
