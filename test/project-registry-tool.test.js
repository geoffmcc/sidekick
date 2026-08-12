const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-project-registry-data');
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

console.log('Running Project Registry Tool Tests...\n');

(async () => {
  try {
    tools.setSource('mcp');

    console.log('Test PRT.1: register canonicalizes the id and preserves the original spelling');
    let result = await TOOLS.project_registry({ action: 'register', project: 'Sidekick-Test', description: 'registry test project' });
    assert.strictEqual(result.isError, undefined);
    let project = JSON.parse(result.content[0].text);
    assert.strictEqual(project.project_id, 'sidekick_test');
    assert.strictEqual(project.display_name, 'Sidekick-Test');
    assert.strictEqual(project.metadata.original_project_id, 'Sidekick-Test');
    assert.strictEqual(project.state, 'active');
    console.log('Passed\n');

    console.log('Test PRT.2: get resolves casing variants to the canonical row; missing project errors');
    result = await TOOLS.project_registry({ action: 'get', project: 'SIDEKICK_TEST' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).project_id, 'sidekick_test');
    result = await TOOLS.project_registry({ action: 'get', project: 'never_registered' });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('not found'));
    result = await TOOLS.project_registry({ action: 'get' });
    assert.strictEqual(result.isError, true);
    console.log('Passed\n');

    console.log('Test PRT.3: list filters by state and archive transitions the project');
    result = await TOOLS.project_registry({ action: 'register', project: 'prt_archive_me' });
    assert.strictEqual(result.isError, undefined);
    result = await TOOLS.project_registry({ action: 'archive', project: 'prt_archive_me', reason: 'test archive' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).state, 'archived');
    result = await TOOLS.project_registry({ action: 'list', state: 'archived' });
    let listing = JSON.parse(result.content[0].text);
    assert.ok(listing.projects.some(p => p.project_id === 'prt_archive_me'));
    result = await TOOLS.project_registry({ action: 'list', state: 'active' });
    listing = JSON.parse(result.content[0].text);
    assert.ok(!listing.projects.some(p => p.project_id === 'prt_archive_me'));
    assert.ok(listing.projects.some(p => p.project_id === 'sidekick_test'));
    result = await TOOLS.project_registry({ action: 'archive', project: 'never_registered' });
    assert.strictEqual(result.isError, true);
    console.log('Passed\n');

    console.log('Test PRT.4: sources lists recorded project sources for casing variants');
    platformKernel.recordProjectSource('sidekick_test', 'custom', 'prt-ref');
    result = await TOOLS.project_registry({ action: 'sources', project: 'Sidekick-Test' });
    assert.strictEqual(result.isError, undefined);
    const sourcesOut = JSON.parse(result.content[0].text);
    assert.strictEqual(sourcesOut.project, 'sidekick_test');
    assert.ok(sourcesOut.sources.some(s => s.source === 'custom' && s.source_id === 'prt-ref'));
    console.log('Passed\n');

    console.log('Test PRT.5: backfill defaults to a dry run that writes nothing');
    result = await TOOLS.store({ key: 'prt_k1', value: 'v', project: 'prt_backfill' });
    assert.strictEqual(result.isError, undefined);
    result = await TOOLS.store({ key: 'prt_k2', value: 'v', project: 'prt_backfill' });
    assert.strictEqual(result.isError, undefined);
    result = await TOOLS.project_registry({ action: 'backfill' });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Dry run'));
    const dryReport = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('{')));
    assert.strictEqual(dryReport.dry_run, true);
    assert.ok(dryReport.written >= 1);
    assert.ok(dryReport.sources.kv >= 1);
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_project_sources WHERE project_id = 'prt_backfill'").get().c, 0);
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_projects WHERE project_id = 'prt_backfill'").get().c, 0);
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_execution_events WHERE event_type = 'project.sources_backfilled'").get().c, 0);
    console.log('Passed\n');

    console.log('Test PRT.6: real backfill requires confirm:true');
    result = await TOOLS.project_registry({ action: 'backfill', dry_run: false });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('confirm:true'));
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_project_sources WHERE project_id = 'prt_backfill'").get().c, 0);
    console.log('Passed\n');

    console.log('Test PRT.7: confirmed backfill writes rows matching the dry-run report');
    result = await TOOLS.project_registry({ action: 'backfill', dry_run: false, confirm: true });
    assert.strictEqual(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Backfill complete'));
    const realReport = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('{')));
    assert.strictEqual(realReport.dry_run, false);
    assert.strictEqual(realReport.written, dryReport.written);
    assert.deepStrictEqual(realReport.sources, dryReport.sources);
    const kvRow = db.getDb().prepare("SELECT * FROM platform_project_sources WHERE project_id = 'prt_backfill' AND source = 'kv' AND source_id = '*'").get();
    assert.ok(kvRow);
    assert.strictEqual(kvRow.count, 2);
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_projects WHERE project_id = 'prt_backfill'").get().c, 1);
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_execution_events WHERE event_type = 'project.sources_backfilled'").get().c, 1);
    console.log('Passed\n');

    console.log('Test PRT.8: unknown action and invalid project ids fail closed');
    result = await TOOLS.project_registry({ action: 'nuke_everything' });
    assert.strictEqual(result.isError, true);
    result = await TOOLS.project_registry({ action: 'register', project: '!!!' });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('non-empty'));
    console.log('Passed\n');

    console.log('Test PRT.9: kernel backfill requires an explicit dry_run boolean');
    assert.throws(() => platformKernel.backfillProjectSources(), /dry_run/);
    assert.throws(() => platformKernel.backfillProjectSources({ dry_run: 'false' }), /dry_run/);
    console.log('Passed\n');

    console.log('Test PRT.10: archive is idempotent and appends a single audit event');
    result = await TOOLS.project_registry({ action: 'archive', project: 'prt_archive_me', reason: 'second archive' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(JSON.parse(result.content[0].text).state, 'archived');
    const archiveEvents = db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_execution_events WHERE event_type = 'project.archived' AND subject_id = 'prt_archive_me'").get().c;
    assert.strictEqual(archiveEvents, 1);
    console.log('Passed\n');

    console.log('Test PRT.11: dispatcher path rejects string coercion of the backfill gates');
    result = await tools.callTool('project_registry', { action: 'backfill', dry_run: 'false', confirm: true });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('Invalid arguments'));
    assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM platform_execution_events WHERE event_type = 'project.sources_backfilled'").get().c, 1);
    console.log('Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Project Registry Tool Tests Passed!');
  } catch (e) {
    console.error('Project registry tool test failed:', e);
    process.exit(1);
  }
})();
