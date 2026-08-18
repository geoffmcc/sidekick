const assert = require('assert');

process.env.SIDEKICK_INFLUX_TOKEN = 'metrics-surface-test-token';
process.env.SIDEKICK_INFLUX_ORG = 'sidekick';
process.env.SIDEKICK_INFLUX_BUCKET = 'sidekick';

const csv = {
  measurements: '#datatype,string,long,string\n#group,false,false,false\n,result,table,_measurement\n,,0,system_health\n,,1,tool_calls\n',
  fields: '#datatype,string,long,string\n#group,false,false,false\n,result,table,_field\n,,0,duration_ms\n,,1,p95_ms\n',
};

const originalFetch = global.fetch;
global.fetch = async (_url, options) => ({
  ok: true,
  text: async () => options.body.includes('_field') ? csv.fields : csv.measurements,
});

const { sidekick_metrics } = require('../src/tools/families/observability');

console.log('Running Metrics Surface Tests...');

(async () => {
  try {
    const measurements = await sidekick_metrics({ action: 'list_measurements' });
    assert.deepStrictEqual(JSON.parse(measurements.content[0].text), ['system_health', 'tool_calls']);

    const fields = await sidekick_metrics({ action: 'list_fields', measurement: 'tool_calls' });
    assert.deepStrictEqual(JSON.parse(fields.content[0].text), ['duration_ms', 'p95_ms']);

    global.fetch = originalFetch;
    console.log('Metrics Surface Tests passed');
  } catch (error) {
    global.fetch = originalFetch;
    console.error(error);
    process.exit(1);
  }
})();
