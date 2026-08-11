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
const scopeGuard = require('../src/security/scope-guard');

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

    console.log('Test PK.5: connector lifecycle protects credentials and records health events');
    assert.throws(() => kernel.registerConnector({ name: 'bad-connector', type: 'http', config: { api_key: 'raw-secret' } }), /secret reference/, 'Connector config should reject raw credentials');
    assert.throws(() => kernel.registerConnector({ name: 'bad-endpoint', type: 'http', endpoint: 'http://user:pass@example.test' }), /without embedded credentials/, 'Connector endpoints should reject embedded credentials');
    const connector = kernel.registerConnector({ name: 'security-research-test', type: 'security-research', endpoint: 'https://example.test/api', secret_ref: 'secret:security-research/api', capabilities: ['findings.read'], config: { region: 'test' } });
    assert.strictEqual(connector.state, 'registered', 'Connectors should start registered');
    assert.strictEqual(connector.secret_ref, 'secret:security-research/api', 'Connector rows should retain only the secret reference');
    const configured = kernel.configureConnector(connector.connector_id, { config: { region: 'test', timeout_ms: 5000 } });
    assert.strictEqual(configured.state, 'configured', 'Connector configuration should advance lifecycle');
    kernel.transitionConnector(connector.connector_id, 'enabled');
    const healthyConnector = kernel.checkConnectorHealth(connector.connector_id, () => ({ ok: true, details: { reachable: true } }));
    assert.strictEqual(healthyConnector.connector.state, 'healthy', 'Passing connector health should reach healthy state');
    const failedConnector = kernel.checkConnectorHealth(connector.connector_id, () => { throw new Error('synthetic connector outage'); });
    assert.strictEqual(failedConnector.connector.state, 'error', 'Thrown connector health should enter error state');
    assert.strictEqual(failedConnector.health.error, 'synthetic connector outage', 'Connector health should retain a bounded failure reason');
    assert.ok(dbStore.getDb().prepare("SELECT COUNT(*) AS count FROM platform_execution_events WHERE event_type = 'connector.health.check' AND subject_id = ?").get(connector.connector_id).count >= 2, 'Connector health checks should emit kernel events');
    console.log('Passed\n');

    console.log('Test PK.6: scope snapshots fail closed and bind allowed executions by digest');
    const snapshot = kernel.createScopeSnapshot({ project_id: 'sidekick', created_by: 'test-operator', targets: [{ kind: 'host', value: 'example.test' }], rules: { allowed_operations: ['observe'] }, expires_at: new Date(Date.now() + 3600000).toISOString() });
    assert.strictEqual(snapshot.target_count, 1, 'Scope snapshots should report target count without exposing target values');
    assert.ok(snapshot.targets[0].value_digest, 'Scope reports should expose target digests');
    const denied = scopeGuard.evaluate({ snapshot_id: snapshot.snapshot_id, project_id: 'sidekick', target_kind: 'host', target: 'other.example.test', operation: 'observe' });
    assert.strictEqual(denied.ok, false, 'Out-of-scope targets must be denied');
    assert.strictEqual(denied.reason, 'target_not_in_scope', 'Scope denial should be explicit');
    const allowed = scopeGuard.evaluate({ snapshot_id: snapshot.snapshot_id, project_id: 'sidekick', target_kind: 'host', target: 'example.test', operation: 'observe' });
    assert.strictEqual(allowed.ok, true, 'In-scope permitted operations should be allowed');
    const scopedExecution = kernel.createExecution({ operation_type: 'security_research_observe', project_id: 'sidekick', actor_id: 'test-operator' });
    const bound = scopeGuard.bindExecution(scopedExecution.execution_id, allowed);
    const boundMetadata = bound.metadata;
    assert.strictEqual(boundMetadata.scope_snapshot_id, snapshot.snapshot_id, 'Execution should bind the scope snapshot');
    assert.strictEqual(boundMetadata.scope_decision_digest, allowed.decision_digest, 'Execution should bind the decision digest');
    assert.throws(() => scopeGuard.bindExecution(scopedExecution.execution_id, denied), /allowed scope decision/, 'Denied scope decisions must never bind');
    console.log('Passed\n');

    console.log('All Platform Kernel tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Platform Kernel test failed:', error);
    process.exit(1);
  }
})();
