// Compute registry tool layer: creating and updating providers/models through
// the MCP tool surface. Every registry row to date had to be inserted with
// direct SQL because the tool surface is snake_case, the registries are
// camelCase, and nothing bridged the two — the dispatcher strips undeclared
// keys, so create hit a NOT NULL column and update silently changed nothing.
//
// Also guards the drift that caused it: any key a tool documents in its `args`
// descriptor must exist in that tool's Zod schema, or callers are told to send
// a parameter that is silently discarded.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'creg-'));
process.env.SIDEKICK_DATA_DIR = TMP;
process.env.SIDEKICK_DB_PATH = path.join(TMP, 'test.db');

const computeTools = require('../src/compute/tools');
const { TOOL_DEFS } = require('../src/tools-legacy');
const { TOOL_SCHEMAS } = require('../src/tools/schemas');

console.log('Running Compute Registry Tool Tests...\n');

let passed = 0;
let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(['ok', name]); }
  catch (e) { failed++; results.push(['fail', name, e.stack || e.message]); }
}

// Tool handlers return MCP content envelopes; unwrap to the payload.
function payload(res) {
  assert.ok(!res.isError, `tool returned an error: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
}
function errorText(res) {
  assert.ok(res.isError, `expected an error, got: ${res.content[0].text}`);
  return res.content[0].text;
}

// Mirrors the dispatcher: strip anything the Zod schema does not declare, so
// these tests exercise what a real caller can actually get through.
function viaSchema(toolName, args) {
  const parsed = TOOL_SCHEMAS[toolName].safeParse(args);
  assert.ok(parsed.success, `schema rejected args: ${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}
const providers = args => computeTools.sidekick_compute_providers(viaSchema('compute_providers', args));
const models = args => computeTools.sidekick_compute_models(viaSchema('compute_models', args));

(async () => {
  let providerId = null;

  await test('create a provider through the tool layer', async () => {
    const p = payload(await providers({
      action: 'create', type: 'ollama', name: 'Test GPU Box',
      base_url: 'http://10.0.0.5:11434',
      capabilities: ['chat', 'generate'], priority: 30,
    }));
    providerId = p.providerId;
    assert.ok(/^prov_/.test(p.providerId), 'provider id generated');
    assert.strictEqual(p.providerType, 'ollama', 'type mapped to providerType');
    assert.strictEqual(p.displayName, 'Test GPU Box', 'name mapped to displayName');
    assert.strictEqual(p.endpoint, 'http://10.0.0.5:11434', 'base_url mapped to endpoint');
    assert.strictEqual(p.priority, 30);
    assert.deepStrictEqual(p.capabilities, ['chat', 'generate']);
  });

  await test('a newly created provider starts at the trust floor', async () => {
    const p = payload(await providers({ action: 'get', provider_id: providerId }));
    assert.strictEqual(p.trustLevel, 'untrusted',
      'create grants connectivity only; the registry default would have ranked equal to trusted');
    assert.deepStrictEqual(p.dataClassifications, ['public'],
      'must not be eligible for private traffic without an explicit promotion');
  });

  await test('create refuses to grant authority; promotion is a separate step', async () => {
    for (const field of ['trust_level', 'data_classifications']) {
      const args = { action: 'create', type: 'ollama', name: 'Sneaky' };
      args[field] = field === 'trust_level' ? 'privileged' : ['private'];
      const msg = errorText(await providers(args));
      assert.match(msg, /cannot be set during create/, `${field} must be refused on create`);
      assert.match(msg, /action=update/, 'points at the promotion path');
    }
  });

  await test('promotion via update works and is what grants private eligibility', async () => {
    const p = payload(await providers({
      action: 'update', provider_id: providerId,
      trust_level: 'trusted', data_classifications: ['public', 'internal', 'private'],
    }));
    assert.strictEqual(p.trustLevel, 'trusted');
    assert.deepStrictEqual(p.dataClassifications, ['public', 'internal', 'private']);
  });

  await test('create reports missing required fields by their tool-facing names', async () => {
    const msg = errorText(await providers({ action: 'create', name: 'No Type' }));
    assert.match(msg, /type/, 'names the missing field');
    assert.ok(!/NOT NULL|SQLITE/i.test(msg), 'must not leak a raw SQLite constraint error');
  });

  await test('loopback and private endpoints stay allowed', async () => {
    // The real host Ollama provider is http://127.0.0.1:11434 and the GPU box
    // is on 10.47.60.10 — a blanket private-address block would break both.
    for (const url of ['http://127.0.0.1:11434', 'http://10.47.60.10:11434',
                       'http://192.168.1.50:8000', 'https://ollama.lan:11434', 'http://[::1]:11434']) {
      const p = payload(await providers({ action: 'create', type: 'ollama', name: `ok ${url}`, base_url: url }));
      assert.strictEqual(p.endpoint, url, `${url} must be accepted`);
    }
  });

  await test('non-HTTP schemes, link-local, metadata hosts and inline credentials are refused', async () => {
    const cases = [
      ['file:///etc/passwd', /scheme/],
      ['gopher://internal:70/', /scheme/],
      ['http://169.254.169.254/', /link-local/],
      ['http://[fe80::1]:11434', /link-local/],
      ['http://metadata.google.internal/', /metadata/],
      ['http://user:pw@10.0.0.9:11434', /credentials embedded/],
      ['not a url', /not a valid URL/],
    ];
    for (const [url, pattern] of cases) {
      const msg = errorText(await providers({ action: 'create', type: 'ollama', name: 'bad', base_url: url }));
      assert.match(msg, pattern, `${url} must be refused`);
    }
  });

  await test('endpoint validation also applies to update', async () => {
    const msg = errorText(await providers({
      action: 'update', provider_id: providerId, base_url: 'http://169.254.169.254/',
    }));
    assert.match(msg, /link-local/);
  });

  await test('update actually applies changes', async () => {
    const p = payload(await providers({
      action: 'update', provider_id: providerId, name: 'Renamed Box', priority: 70, enabled: false,
    }));
    assert.strictEqual(p.displayName, 'Renamed Box');
    assert.strictEqual(p.priority, 70);
    assert.strictEqual(p.enabled, false);
    const reread = payload(await providers({ action: 'get', provider_id: providerId }));
    assert.strictEqual(reread.displayName, 'Renamed Box', 'change persisted, not just echoed');
  });

  await test('update with no usable fields fails instead of reporting a silent no-op', async () => {
    const msg = errorText(await providers({ action: 'update', provider_id: providerId }));
    assert.match(msg, /No updatable fields/);
  });

  await test('an unrecognised trust_level is rejected on promotion, not stored', async () => {
    const msg = errorText(await providers({
      action: 'update', provider_id: providerId, trust_level: 'supertrusted',
    }));
    assert.match(msg, /Invalid trust_level/);
    // trustRank() maps an unknown label to 0, so storing it would silently make
    // the provider unselectable with no signal to the operator.
    assert.match(msg, /untrusted, limited, trusted, privileged/);
  });

  await test('an unrecognised data classification is rejected on promotion', async () => {
    const msg = errorText(await providers({
      action: 'update', provider_id: providerId, data_classifications: ['public', 'top-secret'],
    }));
    assert.match(msg, /Invalid data_classifications/);
    assert.match(msg, /top-secret/, 'names the offending value');
  });

  await test('validation applies to update as well as create', async () => {
    const msg = errorText(await providers({
      action: 'update', provider_id: providerId, trust_level: 'nonsense',
    }));
    assert.match(msg, /Invalid trust_level/);
  });

  await test('list filters by type instead of returning everything', async () => {
    payload(await providers({
      action: 'create', type: 'openai', name: 'Other', capabilities: ['chat'],
    }));
    const ollama = payload(await providers({ action: 'list', type: 'ollama' }));
    assert.ok(ollama.length >= 1, 'finds the ollama provider');
    assert.ok(ollama.every(p => p.providerType === 'ollama'), 'filter actually bound');
    const all = payload(await providers({ action: 'list' }));
    assert.ok(all.length > ollama.length, 'unfiltered list is genuinely larger');
  });

  let modelId = null;

  await test('create a model through the tool layer', async () => {
    const m = payload(await models({
      action: 'create', provider_id: providerId, model_name: 'Qwen 3.5',
      provider_model_name: 'qwen3.5:latest', capabilities: ['chat'],
      context_length: 262144, supports_tools: true,
      family: 'qwen', parameter_count: '7b', min_vram_gb: 8,
    }));
    modelId = m.modelId;
    assert.ok(/^model_/.test(m.modelId), 'model id generated');
    assert.strictEqual(m.providerId, providerId, 'provider_id mapped to providerId');
    assert.strictEqual(m.displayName, 'Qwen 3.5', 'model_name mapped to displayName');
    assert.strictEqual(m.providerModelName, 'qwen3.5:latest');
    assert.strictEqual(m.contextLimit, 262144, 'context_length mapped to contextLimit');
    assert.strictEqual(m.supportsTools, true);
    assert.deepStrictEqual(m.capabilities, ['chat']);
  });

  await test('min_vram_gb is converted to bytes, not stored as gigabytes', async () => {
    const m = payload(await models({ action: 'get', model_id: modelId }));
    assert.strictEqual(m.estimatedMemoryBytes, 8 * 1024 ** 3,
      'a raw 8 here would mean 8 bytes of VRAM');
  });

  await test('family and parameter_count are kept as metadata', async () => {
    const m = payload(await models({ action: 'get', model_id: modelId }));
    assert.strictEqual(m.metadata.family, 'qwen');
    assert.strictEqual(m.metadata.parameterCount, '7b');
  });

  await test('model create reports missing required fields', async () => {
    const msg = errorText(await models({ action: 'create', model_name: 'Orphan' }));
    assert.match(msg, /provider_id/);
    assert.match(msg, /provider_model_name/);
  });

  await test('model update applies and persists', async () => {
    payload(await models({ action: 'update', model_id: modelId, enabled: false, context_length: 8192 }));
    const m = payload(await models({ action: 'get', model_id: modelId }));
    assert.strictEqual(m.enabled, false);
    assert.strictEqual(m.contextLimit, 8192);
  });

  await test('a partial metadata update preserves the keys it did not mention', async () => {
    payload(await models({ action: 'update', model_id: modelId, family: 'qwen2' }));
    const m = payload(await models({ action: 'get', model_id: modelId }));
    assert.strictEqual(m.metadata.family, 'qwen2', 'the supplied key changed');
    assert.strictEqual(m.metadata.parameterCount, '7b',
      'the registry replaces the whole metadata column, so an unmentioned key must be carried over');
  });

  await test('model list filters by provider instead of returning everything', async () => {
    const mine = payload(await models({ action: 'list', provider_id: providerId }));
    assert.ok(mine.length >= 1);
    assert.ok(mine.every(m => m.providerId === providerId), 'filter actually bound');
  });

  // --- drift guard ---

  await test('every documented arg key exists in the tool schema', () => {
    const drifted = [];
    // Resolve schemas from the registry, not the raw TOOL_SCHEMAS catalog: tools
    // owned by descriptor families carry their schema in the family module, so a
    // catalog lookup would silently skip them and drop this guard's coverage.
    const registrySchemas = require('../src/tools').getBuiltinRegistry().schemas();
    for (const def of TOOL_DEFS) {
      const schema = registrySchemas[def.name];
      if (!schema || !schema.shape || !def.args) continue;
      for (const key of Object.keys(def.args)) {
        if (!(key in schema.shape)) drifted.push(`${def.name}.${key}`);
      }
    }
    assert.deepStrictEqual(drifted, [],
      'documented args missing from the schema are silently stripped by the dispatcher, ' +
      'so callers following the docs get silently wrong results');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  for (const [status, name, detail] of results) {
    if (status === 'ok') console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    else { console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${detail}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
