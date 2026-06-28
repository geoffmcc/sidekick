const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-insight-report');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/tools')];
const { TOOLS, setSource } = require('../src/tools');
const { sidekick_insight_report, sidekick_tools } = TOOLS;

console.log('Running Insight Report Tests...\n');

(async () => {
  try {
    setSource('mcp');

    const logFile = path.join(TEST_DATA_DIR, 'app.log');
    const csvFile = path.join(TEST_DATA_DIR, 'metrics.csv');
    const jsonFile = path.join(TEST_DATA_DIR, 'events.json');

    fs.writeFileSync(logFile, [
      'service started',
      'WARN cache timeout',
      'ERROR database failed',
      'service started'
    ].join('\n'), 'utf-8');
    fs.writeFileSync(csvFile, 'name,count\napi,3\nworker,7\n', 'utf-8');
    fs.writeFileSync(jsonFile, JSON.stringify([{ id: 1, status: 'ok' }, { id: 2, status: 'failed' }]), 'utf-8');

    console.log('Test: sidekick_insight_report - combined text and data report');
    const result = await sidekick_insight_report({
      paths: [logFile, csvFile, jsonFile],
      title: 'Test Insight Report'
    });
    assert.ok(!result.isError, 'Insight report should succeed');
    const report = result.content[0].text;
    assert.ok(report.includes('# Test Insight Report'), 'Should use supplied title');
    assert.ok(report.includes('Analyzed 3 file(s)'), 'Should summarize file count');
    assert.ok(report.includes('error/warning-looking lines found'), 'Should report log evidence');
    assert.ok(report.includes('csv data with 2 rows'), 'Should summarize CSV shape');
    assert.ok(report.includes('json data with 2 rows'), 'Should summarize JSON array shape');
    assert.ok(report.includes(logFile), 'Should cite text source path');
    assert.ok(report.includes(csvFile), 'Should cite data source path');
    assert.ok(report.includes('## Likely Root Cause'), 'Should include interpretive root cause section');
    assert.ok(report.includes('## Confidence'), 'Should include confidence section');
    assert.ok(report.includes('## Next Actions'), 'Should include next actions');
    console.log('✓ Passed\n');

    console.log('Test: sidekick_insight_report - stale session incident analysis');
    const incidentFile = path.join(TEST_DATA_DIR, 'mcp-incident.md');
    fs.writeFileSync(incidentFile, [
      'Jun 28 16:45:26 sidekick sudo: COMMAND=/usr/bin/systemctl restart sidekick-mcp',
      'Jun 28 16:45:26 sidekick node: Sidekick MCP server listening on port 4097',
      'Jun 28 16:45:26 sidekick node: STALE_SESSION_CREATING_REPLACEMENT staleSessionId=sess-old',
      'Jun 28 16:45:26 sidekick node: CREATED_REPLACEMENT_SESSION newSessionId=sess-new',
      'Jun 28 16:45:26 sidekick node: INVALID_SESSION_RESPONSE sessionId=sess-old replacementId=sess-new',
      'Jun 28 16:45:59 sidekick node: REUSE_SESSION sessionId=sess-new'
    ].join('\n'), 'utf-8');
    const incident = await sidekick_insight_report({ paths: incidentFile, title: 'MCP Incident' });
    assert.ok(!incident.isError, 'Incident report should succeed');
    const incidentReport = incident.content[0].text;
    assert.ok(incidentReport.includes('## Timeline'), 'Should include timeline for timestamped evidence');
    assert.ok(incidentReport.includes('post-deployment session invalidation'), 'Should infer stale-session root cause');
    assert.ok(incidentReport.includes('High'), 'Should have high confidence when recovery evidence is present');
    assert.ok(incidentReport.includes('replacement session ID'), 'Should recommend replacement-session handling');
    console.log('✓ Passed\n');

    console.log('Test: sidekick_insight_report - comma-separated paths and missing file');
    const missing = path.join(TEST_DATA_DIR, 'missing.txt');
    const mixed = await sidekick_insight_report({ paths: `${logFile},${missing}` });
    assert.ok(!mixed.isError, 'Missing input should be captured as report evidence, not fail the whole report');
    assert.ok(mixed.content[0].text.includes('1 file(s) had errors'), 'Should count file errors');
    assert.ok(mixed.content[0].text.includes('File not found'), 'Should include missing file evidence');
    console.log('✓ Passed\n');

    console.log('Test: sidekick_insight_report - missing paths');
    const empty = await sidekick_insight_report({});
    assert.ok(empty.isError, 'Missing paths should fail validation');
    assert.ok(empty.content[0].text.includes('paths is required'), 'Should explain missing paths');
    console.log('✓ Passed\n');

    console.log('Test: sidekick_tools catalog includes insight report');
    const catalog = await sidekick_tools({ action: 'get', name: 'sidekick_insight_report', format: 'json' });
    assert.ok(!catalog.isError, 'Catalog lookup should succeed');
    const tool = JSON.parse(catalog.content[0].text);
    assert.strictEqual(tool.name, 'sidekick_insight_report', 'Catalog should include tool name');
    assert.strictEqual(tool.category, 'Data Pipeline', 'Tool should be categorized as Data Pipeline');
    assert.strictEqual(tool.risk, 'low', 'Tool should be low risk');
    console.log('✓ Passed\n');

    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('All Insight Report Tests Passed! ✓');
  } catch (e) {
    console.error('Test failed:', e);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  }
})();
