const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-metrics-surface-'));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_SECRET_KEY = 'synthetic-metrics-surface-secret-key';
process.env.SIDEKICK_API_KEY = 'synthetic-metrics-surface-api-key';
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';

process.env.SIDEKICK_INFLUX_TOKEN_FILE = path.join(TEST_DATA_DIR, 'influx-token');
fs.writeFileSync(process.env.SIDEKICK_INFLUX_TOKEN_FILE, 'metrics-surface-test-token');
delete process.env.SIDEKICK_INFLUX_TOKEN;
process.env.SIDEKICK_INFLUX_ORG = 'sidekick';
process.env.SIDEKICK_INFLUX_BUCKET = 'sidekick';

const csv = {
  measurements: '#datatype,string,long,string\n#group,false,false,false\n,result,table,_measurement\n,,0,system_health\n,,1,tool_calls\n',
  fields: '#datatype,string,long,string\n#group,false,false,false\n,result,table,_field\n,,0,duration_ms\n,,1,p95_ms\n',
};

const originalFetch = global.fetch;
let fetchCalls = 0;
global.fetch = async (_url, options) => {
  assert.equal(options.redirect, 'error', 'metrics requests must not forward credentials through redirects');
  assert.ok(options.signal instanceof AbortSignal, 'metrics requests must have a finite deadline');
  fetchCalls++;
  return new Response(options.body.includes('_field') ? csv.fields : csv.measurements, { status: 200 });
};

const tools = require('../src/tools');
const rawObservability = require('../src/tools/families/observability');
const TOOLS = require('./helpers/authorized-context').withOwnerToolContext(tools.TOOLS, { source: 'test' });

console.log('Running Metrics Surface Tests...');

(async () => {
  try {
    assert.strictEqual((await rawObservability.sidekick_metrics({ action: 'list_measurements' })).code, 'unauthenticated');
    const measurements = await TOOLS.metrics({ action: 'list_measurements' });
    assert.ok(!measurements.isError, measurements.content?.[0]?.text);
    assert.deepStrictEqual(JSON.parse(measurements.content[0].text), ['system_health', 'tool_calls']);
    const cachedMeasurements = await TOOLS.metrics({ action: 'list_measurements' });
    assert.deepStrictEqual(JSON.parse(cachedMeasurements.content[0].text), ['system_health', 'tool_calls']);

    const fields = await TOOLS.metrics({ action: 'list_fields', measurement: 'tool_calls' });
    assert.deepStrictEqual(JSON.parse(fields.content[0].text), ['duration_ms', 'p95_ms']);
    assert.strictEqual(fetchCalls, 2, 'repeated metadata reads should use the short TTL cache');

    await assert.rejects(
      rawObservability.readInfluxResponseText(new Response('0123456789'), 5),
      /response exceeded the configured size limit/,
    );
    assert.equal(await rawObservability.readInfluxResponseText(new Response('bounded'), 16), 'bounded');

    global.fetch = originalFetch;
    try { require('../src/db').closeDatabase(); } catch {}
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('Metrics Surface Tests passed');
  } catch (error) {
    global.fetch = originalFetch;
    try { require('../src/db').closeDatabase(); } catch {}
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  }
})();
