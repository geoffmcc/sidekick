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
    const artifact = kernel.registerArtifact({
      execution_id: execution.execution_id,
      project_id: 'sidekick',
      type: 'report',
      name: 'assessment',
      storage_ref: 'reports/platform-assessment.md',
      content_type: 'text/markdown',
      content_hash: 'sha256:test',
    });
    assert.strictEqual(artifact.storage_ref, 'reports/platform-assessment.md', 'Artifact metadata should be stored');
    const withArtifact = kernel.getExecution(execution.execution_id);
    assert.strictEqual(withArtifact.artifact_count, 1, 'Artifact count should be linked to execution');
    console.log('Passed\n');

    console.log('All Platform Kernel tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Platform Kernel test failed:', error);
    process.exit(1);
  }
})();
