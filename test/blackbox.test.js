const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-blackbox');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'blackbox'), { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_BLACKBOX_DAILY_LIMIT = '50';

const legacyId = 'bb_legacy_fixture';
fs.writeFileSync(path.join(TEST_DATA_DIR, 'blackbox.json'), JSON.stringify({
  incidents: {
    [legacyId]: {
      name: 'legacy fixture',
      captured: Date.now() - 60000,
      sources: ['services', 'logs'],
      size: 42
    }
  }
}, null, 2));
fs.writeFileSync(path.join(TEST_DATA_DIR, 'blackbox', legacyId), '# legacy payload\nTOKEN=secret-token-value\nservice failed\n');

delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/blackbox')];
delete require.cache[require.resolve('../src/tools')];
const blackbox = require('../src/blackbox');
const { TOOLS } = require('../src/tools');
const dbStore = require('../src/db');

console.log('Running Black Box Tests...\n');

(async () => {
  try {
    console.log('Test BB.1: legacy migration preserves IDs and redacts artifacts');
    const legacy = blackbox.getIncident(legacyId, { includeCaptures: true });
    assert.ok(legacy, 'Legacy incident should be imported');
    assert.strictEqual(legacy.id, legacyId, 'Legacy ID should be preserved');
    assert.ok(fs.readdirSync(TEST_DATA_DIR).some(name => name.startsWith('blackbox.json.bak-')), 'Legacy metadata backup should be created');
    const legacySource = blackbox.getSource('legacy_bundle');
    assert.ok(legacySource.stdout.includes('# legacy payload'), 'Legacy payload should be available as source artifact');
    assert.ok(!legacySource.stdout.includes('secret-token-value'), 'Legacy artifact should be redacted');
    console.log('Passed\n');

    console.log('Test BB.2: quick capture creates incident, capture, source, event records');
    const capture = await blackbox.captureIncident({ name: 'quick fixture', profile: 'quick', include: ['system.identity'] });
    assert.ok(capture.incident_id, 'Capture should have incident ID');
    assert.strictEqual(capture.source_count, 1, 'Selected source should be honored');
    assert.ok(['completed', 'partial'].includes(capture.state), 'Capture should finish with useful state');
    const incident = blackbox.getIncident(capture.incident_id, { includeTimeline: true });
    assert.ok(incident.timeline.some(e => e.event_type === 'capture.capture_started'), 'Timeline should record capture start');
    const sources = blackbox.listSources(capture.id);
    assert.strictEqual(sources.length, 1, 'Source should be stored');
    assert.ok(sources[0].content_hash, 'Source should have content hash');
    const platformExecution = dbStore.getDb().prepare("SELECT * FROM platform_executions WHERE incident_id = ? AND operation_type = 'incident_capture'").get(capture.incident_id);
    assert.ok(platformExecution, 'Capture should create a platform execution');
    assert.strictEqual(platformExecution.tool_name, 'sidekick_black_box', 'Platform execution should identify the Black Box tool');
    assert.strictEqual(platformExecution.state, capture.state, 'Platform execution should mirror final capture state');
    assert.ok(platformExecution.artifact_count >= 1, 'Capture artifacts should be linked to platform execution');
    const platformEvents = dbStore.getDb().prepare('SELECT event_type FROM platform_execution_events WHERE execution_id = ? ORDER BY timestamp ASC').all(platformExecution.execution_id).map(row => row.event_type);
    assert.ok(platformEvents.includes('blackbox.source_started'), 'Platform events should include source start');
    assert.ok(platformEvents.includes('blackbox.source_completed'), 'Platform events should include source completion');
    console.log('Passed\n');

    console.log('Test BB.3: source detail, search, deterministic analysis, and export are evidence-linked');
    const source = blackbox.getSource(blackbox.listSources(capture.id)[0].id);
    assert.ok(source.stdout.length > 0 || source.error_message, 'Source detail should expose safe output or explicit error');
    const results = blackbox.searchIncidents('quick fixture');
    assert.ok(results.some(r => r.incident_id === capture.incident_id), 'Search should find incident metadata');
    const analysis = await blackbox.analyzeIncident(capture.incident_id, { llm: null });
    assert.ok(Array.isArray(analysis.cited_source_ids), 'Analysis should include cited source IDs');
    assert.ok(analysis.cited_source_ids.length > 0, 'Analysis should cite evidence sources');
    const exported = blackbox.exportIncident(capture.incident_id, { format: 'json' });
    assert.strictEqual(exported.schema_version, 11, 'Export should include schema version');
    assert.ok(exported.incident.captures[0].sources[0].content_hash, 'Export should include artifact hashes');
    console.log('Passed\n');

    console.log('Test BB.4: comparison, retention, pinning, purge preview, and delete');
    const capture2 = await blackbox.captureIncident({ incident_id: capture.incident_id, profile: 'quick', include: ['system.identity'], capture_type: 'verification' });
    const comparison = blackbox.compareCaptures(capture.id, capture2.id);
    assert.strictEqual(comparison.before_capture_id, capture.id, 'Comparison should identify before capture');
    const pinned = blackbox.updateIncident(capture.incident_id, { pinned: true, retention_class: 'pinned' }, 'test');
    assert.strictEqual(pinned.pinned, true, 'Incident should be pinned');
    assert.strictEqual(pinned.expires_at, null, 'Pinned incident should not expire');
    const preview = blackbox.purgePreview();
    assert.ok(!preview.incidents.some(i => i.id === capture.incident_id), 'Pinned incident should not appear in purge preview');
    assert.strictEqual(blackbox.deleteIncident(capture.incident_id, 'test'), true, 'Delete should remove incident');
    assert.strictEqual(blackbox.getIncident(capture.incident_id), null, 'Deleted incident should not remain indexed');
    console.log('Passed\n');

    console.log('Test BB.5: MCP compatibility and structured actions');
    const mcpCapture = await TOOLS.sidekick_black_box({ action: 'capture', name: 'mcp fixture', include: ['system.identity'] });
    assert.ok(!mcpCapture.isError, 'MCP capture should succeed');
    const payload = JSON.parse(mcpCapture.content[0].text);
    assert.ok(payload.incident_id && payload.capture_id, 'MCP capture should return structured IDs');
    const mcpGet = await TOOLS.sidekick_black_box({ action: 'get_incident', incident_id: payload.incident_id });
    assert.ok(!mcpGet.isError, 'MCP get_incident should succeed');
    const mcpSource = await TOOLS.sidekick_black_box({ action: 'get_source', source_id: payload.sources[0].id, limit: 4096 });
    assert.ok(!mcpSource.isError, 'MCP get_source should expose explicit source detail');
    await TOOLS.sidekick_black_box({ action: 'delete', incident_id: payload.incident_id });
    console.log('Passed\n');

    console.log('All Black Box tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Black Box test failed:', error);
    process.exit(1);
  }
})();
