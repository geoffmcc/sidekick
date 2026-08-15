// B3 completion regression: EVERY kernel writer that binds a project_id must
// pass it through the normalizeProjectId choke point (canonicalizeProjectName
// from src/core/project-identity.js). appendEvent, createProjectWorkspace and
// createScopeSnapshot used to bind the raw input, forking casing/charset
// variants of one project into parallel identities. Null passthrough is part
// of the contract for the writers where project is optional.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-kernel-canonicalization-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_SECRET_KEY = 'canon-test-key';

delete require.cache[require.resolve('../src/db')];
const db = require('../src/db');
const platformKernel = require('../src/platform/kernel');
const { canonicalizeProjectName } = require('../src/core/project-identity');

console.log('Running Kernel Canonicalization Tests...\n');

try {
  platformKernel.ensurePlatformKernelSchema();

  console.log('Test KC.1: appendEvent canonicalizes project_id and keeps null passthrough');
  const event = platformKernel.appendEvent({
    event_type: 'test.canonicalization',
    source: 'platform',
    project_id: 'Canon-Event Project',
    payload: {},
  });
  const eventRow = db.getDb().prepare('SELECT project_id FROM platform_execution_events WHERE event_id = ?').get(event.event_id);
  assert.strictEqual(eventRow.project_id, 'canon_event_project');
  const nullEvent = platformKernel.appendEvent({ event_type: 'test.canonicalization', source: 'platform', payload: {} });
  assert.strictEqual(db.getDb().prepare('SELECT project_id FROM platform_execution_events WHERE event_id = ?').get(nullEvent.event_id).project_id, null);
  const emptyEvent = platformKernel.appendEvent({ event_type: 'test.canonicalization', source: 'platform', project_id: '', payload: {} });
  assert.strictEqual(db.getDb().prepare('SELECT project_id FROM platform_execution_events WHERE event_id = ?').get(emptyEvent.event_id).project_id, null);
  console.log('Passed\n');

  console.log('Test KC.2: createProjectWorkspace canonicalizes project_id (row, event, and lookup agree)');
  const ws = platformKernel.createProjectWorkspace({ project_id: 'Canon-WS Project' });
  assert.strictEqual(ws.project_id, 'canon_ws_project');
  const wsRow = db.getDb().prepare('SELECT project_id FROM platform_project_workspaces WHERE workspace_id = ?').get(ws.workspace_id);
  assert.strictEqual(wsRow.project_id, 'canon_ws_project');
  const wsEvent = db.getDb().prepare("SELECT project_id FROM platform_execution_events WHERE event_type = 'workspace.created' AND subject_id = ?").get(ws.workspace_id);
  assert.strictEqual(wsEvent.project_id, 'canon_ws_project');
  // A casing variant resolves to the same workspace.
  assert.strictEqual(platformKernel.getWorkspaceByProject('CANON_WS_PROJECT').workspace_id, ws.workspace_id);
  // project_id is NOT NULL on this table: omitting it still fails (schema
  // enforced), it is not silently defaulted by the canonicalization.
  assert.throws(() => platformKernel.createProjectWorkspace({ name: 'no_project_ws' }), /NOT NULL|non-empty/);
  console.log('Passed\n');

  console.log('Test KC.3: createScopeSnapshot canonicalizes project_id');
  const snapshot = platformKernel.createScopeSnapshot({
    project_id: 'Canon-Scope Project',
    created_by: 'canon-test',
    targets: [{ kind: 'host', value: 'synthetic.test' }],
  });
  assert.strictEqual(snapshot.project_id, 'canon_scope_project');
  // The canonical id is what scope evaluation compares against.
  const decision = platformKernel.evaluateScope(snapshot.snapshot_id, {
    project_id: 'canon_scope_project', target: 'synthetic.test', target_kind: 'host', operation: 'probe',
  });
  assert.strictEqual(decision.ok, true, decision.reason);
  assert.throws(() => platformKernel.createScopeSnapshot({ created_by: 'canon-test', targets: [{ kind: 'host', value: 'x' }] }), /project_id is required/);
  console.log('Passed\n');

  console.log('Test KC.4: memory inference uses the shared canonicalizer from core/project-identity');
  const memorySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory.js'), 'utf8');
  assert.ok(/canonicalizeProjectName/.test(memorySource), 'memory.js imports the shared canonicalizer');
  assert.ok(!/toLowerCase\(\)\.replace\(\/\[\^a-z0-9_\]\+\/g/.test(memorySource), 'memory.js no longer re-implements canonicalization inline');
  const { inferProjectFromText } = require('../src/memory');
  assert.strictEqual(inferProjectFromText('working on project sidekick today'), 'sidekick');
  assert.strictEqual(inferProjectFromText('repo my-cool-repo needs a fix'), canonicalizeProjectName('my-cool-repo'));
  console.log('Passed\n');

  console.log('Test KC.5: backfillProjectSources reports unreadable sources instead of dropping them');
  const report = platformKernel.backfillProjectSources({ dry_run: true });
  assert.ok(report.errors && typeof report.errors === 'object', 'report carries an errors object');
  // In this minimal database several scan tables (e.g. memories) do not exist;
  // each unreadable source must be named with its error rather than skipped.
  const errorSources = Object.keys(report.errors);
  for (const source of errorSources) {
    assert.ok(report.errors[source].table, `error entry for ${source} names the table`);
    assert.ok(report.errors[source].error, `error entry for ${source} carries the message`);
    assert.ok(!(source in report.sources), `an unreadable source is not also reported as scanned: ${source}`);
  }
  assert.ok(errorSources.length >= 1, 'this minimal DB should have at least one unreadable scan source');
  console.log('Passed\n');

  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  console.log('All Kernel Canonicalization Tests Passed!');
} catch (e) {
  console.error('Kernel canonicalization test failed:', e);
  process.exit(1);
}
