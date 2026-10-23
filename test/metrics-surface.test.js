const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

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

let requestCount = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    requestCount++;
    assert.equal(req.headers.authorization, 'Token metrics-surface-test-token', 'the Influx token is sent only to the configured endpoint');
    const body = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    res.end(body.includes('_field') ? csv.fields : csv.measurements);
  });
});

const tools = require('../src/tools');
const rawObservability = require('../src/tools/families/observability');
const TOOLS = require('./helpers/authorized-context').withOwnerToolContext(tools.TOOLS, { source: 'test' });
const { dispatchTestTool } = require('../src/tools/dispatcher');
const { createOwnerContext } = require('./helpers/authorized-context');

console.log('Running Metrics Surface Tests...');

(async () => {
  const previousInfluxUrl = process.env.SIDEKICK_INFLUX_URL;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.SIDEKICK_INFLUX_URL = `http://127.0.0.1:${server.address().port}`;
    assert.strictEqual((await rawObservability.sidekick_metrics({ action: 'list_measurements' })).code, 'unauthenticated');
    const ownerContext = createOwnerContext();
    const identity = require('../src/core/identity');
    const metricsPrincipal = identity.createPrincipal({ type: 'service', displayName: 'Synthetic metrics-only principal' });
    identity.grantPrincipalPermission(metricsPrincipal.principal_id, 'tools.execute', ownerContext.authIdentity.principal_id);
    identity.grantPrincipalPermission(metricsPrincipal.principal_id, 'tools.execute_high', ownerContext.authIdentity.principal_id);
    const limitedContext = { source: 'test', authIdentity: { principal_id: metricsPrincipal.principal_id } };
    const limited = await dispatchTestTool({
      descriptor: rawObservability.descriptors.find(item => item.name === 'metrics'),
      args: { action: 'list_measurements' },
      context: limitedContext,
    });
    assert.equal(limited.code, 'forbidden', 'tool execution scope alone must not grant access to Influx secrets');
    assert.equal(requestCount, 0, 'denied secret use must prevent outbound request');
    const measurements = await TOOLS.metrics({ action: 'list_measurements' });
    assert.ok(!measurements.isError, measurements.content?.[0]?.text);
    assert.deepStrictEqual(JSON.parse(measurements.content[0].text), ['system_health', 'tool_calls']);
    const cachedMeasurements = await TOOLS.metrics({ action: 'list_measurements' });
    assert.deepStrictEqual(JSON.parse(cachedMeasurements.content[0].text), ['system_health', 'tool_calls']);

    const fields = await TOOLS.metrics({ action: 'list_fields', measurement: 'tool_calls' });
    assert.deepStrictEqual(JSON.parse(fields.content[0].text), ['duration_ms', 'p95_ms']);
    assert.strictEqual(requestCount, 2, 'repeated metadata reads should use the short TTL cache');

    await assert.rejects(
      rawObservability.readInfluxResponseText(new Response('0123456789'), 5),
      /response exceeded the configured size limit/,
    );
    assert.equal(await rawObservability.readInfluxResponseText(new Response('bounded'), 16), 'bounded');

    if (previousInfluxUrl === undefined) delete process.env.SIDEKICK_INFLUX_URL;
    else process.env.SIDEKICK_INFLUX_URL = previousInfluxUrl;
    await new Promise(resolve => server.close(resolve));
    try { require('../src/db').closeDatabase(); } catch {}
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('Metrics Surface Tests passed');
  } catch (error) {
    if (previousInfluxUrl === undefined) delete process.env.SIDEKICK_INFLUX_URL;
    else process.env.SIDEKICK_INFLUX_URL = previousInfluxUrl;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    try { require('../src/db').closeDatabase(); } catch {}
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  }
})();
