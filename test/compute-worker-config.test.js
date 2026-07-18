// Phase 3 — persistent worker configuration.
// Validates the config schema, stable node-id derivation, config-file loading,
// and the CLI > env > file > defaults precedence via the env substrate.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../src/compute/worker-config');

console.log('Running Compute Worker Config Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${e.stack || e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wcfg-'));
function writeConfig(name, obj) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

// Env vars this module may touch; isolate them per applyConfigToEnv test.
const MANAGED_ENV = [
  'SIDEKICK_NODE_ID', 'SIDEKICK_NODE_NAME', 'SIDEKICK_WORKER_CONCURRENCY', 'SIDEKICK_HEARTBEAT_MS',
  'SIDEKICK_WORKER_POLL_MS', 'SIDEKICK_URL', 'SIDEKICK_SERVER_URL', 'SIDEKICK_OPENVINO_ENABLED',
  'SIDEKICK_OPENVINO_PYTHON', 'SIDEKICK_OPENVINO_MODELS_DIR', 'OLLAMA_URL', 'SIDEKICK_WORKER_CONFIG_FILE',
];
function withCleanEnv(preset, fn) {
  const saved = {};
  for (const k of MANAGED_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    for (const [k, v] of Object.entries(preset || {})) process.env[k] = v;
    fn();
  } finally {
    for (const k of MANAGED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const validConfig = {
  serverUrl: 'http://10.0.0.5:4097',
  nodeId: 'node_abc123def456',
  displayName: 'Lab Worker',
  concurrency: 4,
  heartbeatMs: 30000,
  pollMs: 2000,
  openvino: { enabled: true, pythonPath: '/opt/py/python', modelsDir: '/opt/models' },
  ollama: { enabled: true, url: 'http://127.0.0.1:11434' },
};

// --- Schema validation ---
test('validateConfig accepts a full valid config', () => {
  assert.strictEqual(cfg.validateConfig(JSON.parse(JSON.stringify(validConfig))), true);
});
test('validateConfig rejects unknown top-level field', () => {
  assert.throws(() => cfg.validateConfig({ ...validConfig, bogus: 1 }), /not a recognized option/);
});
test('validateConfig rejects unknown nested field', () => {
  assert.throws(() => cfg.validateConfig({ openvino: { enabled: true, foo: 1 } }), /openvino\.foo is not a recognized option/);
});
test('validateConfig rejects wrong scalar type', () => {
  assert.throws(() => cfg.validateConfig({ concurrency: '4' }), /concurrency must be an integer/);
});
test('validateConfig rejects out-of-range integer', () => {
  assert.throws(() => cfg.validateConfig({ concurrency: 17 }), /concurrency must be <= 16/);
  assert.throws(() => cfg.validateConfig({ heartbeatMs: 1000 }), /heartbeatMs must be >= 5000/);
});
test('validateConfig rejects bad nodeId pattern', () => {
  assert.throws(() => cfg.validateConfig({ nodeId: 'Bad ID!' }), /nodeId does not match/);
});
test('validateConfig rejects non-URI serverUrl', () => {
  assert.throws(() => cfg.validateConfig({ serverUrl: 'not a url' }), /serverUrl must be a valid URI/);
});

// --- Stable node id ---
test('generateStableNodeId is deterministic and matches schema pattern', () => {
  const a = cfg.generateStableNodeId();
  const b = cfg.generateStableNodeId();
  assert.strictEqual(a, b, 'stable across calls');
  assert.match(a, /^node_[0-9a-f]{16}$/);
  assert.match(a, new RegExp(cfg.CONFIG_SCHEMA.properties.nodeId.pattern));
});

// --- defaultConfigPath ---
test('defaultConfigPath points at a config.json', () => {
  assert.ok(cfg.defaultConfigPath().endsWith('config.json'));
});

// --- loadConfigFile ---
test('loadConfigFile returns exists:false for an absent file', () => {
  const r = cfg.loadConfigFile(path.join(TMP, 'nope.json'));
  assert.strictEqual(r.exists, false);
  assert.deepStrictEqual(r.config, {});
});
test('loadConfigFile parses a valid file and strips $schema', () => {
  const p = writeConfig('valid.json', { $schema: 'https://json-schema.org/draft-07/schema', ...validConfig });
  const r = cfg.loadConfigFile(p);
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.config.serverUrl, validConfig.serverUrl);
  assert.strictEqual(r.config.$schema, undefined, '$schema stripped before validation');
});
test('loadConfigFile throws on malformed JSON', () => {
  const p = writeConfig('bad.json', '{ not json');
  assert.throws(() => cfg.loadConfigFile(p), e => e.code === 'WORKER_CONFIG_PARSE');
});
test('loadConfigFile throws on schema-invalid file', () => {
  const p = writeConfig('invalid.json', { concurrency: 99 });
  assert.throws(() => cfg.loadConfigFile(p), e => e.code === 'WORKER_CONFIG_INVALID');
});

// --- applyConfigToEnv precedence ---
test('applyConfigToEnv fills unset env vars from file', () => {
  withCleanEnv({}, () => {
    cfg.applyConfigToEnv(validConfig);
    assert.strictEqual(process.env.SIDEKICK_NODE_NAME, 'Lab Worker');
    assert.strictEqual(process.env.SIDEKICK_WORKER_CONCURRENCY, '4');
    assert.strictEqual(process.env.SIDEKICK_HEARTBEAT_MS, '30000');
    assert.strictEqual(process.env.SIDEKICK_SERVER_URL, 'http://10.0.0.5:4097');
    assert.strictEqual(process.env.SIDEKICK_OPENVINO_ENABLED, 'true');
    assert.strictEqual(process.env.SIDEKICK_OPENVINO_PYTHON, '/opt/py/python');
    assert.strictEqual(process.env.OLLAMA_URL, 'http://127.0.0.1:11434');
  });
});
test('applyConfigToEnv does not override an already-set env var (env > file)', () => {
  withCleanEnv({ SIDEKICK_NODE_NAME: 'FromEnv', SIDEKICK_WORKER_CONCURRENCY: '8' }, () => {
    cfg.applyConfigToEnv(validConfig);
    assert.strictEqual(process.env.SIDEKICK_NODE_NAME, 'FromEnv', 'env wins over file');
    assert.strictEqual(process.env.SIDEKICK_WORKER_CONCURRENCY, '8', 'env wins over file');
  });
});
test('applyConfigToEnv respects SIDEKICK_URL as an alias when seeding serverUrl', () => {
  withCleanEnv({ SIDEKICK_URL: 'http://preset:4097' }, () => {
    cfg.applyConfigToEnv(validConfig);
    assert.strictEqual(process.env.SIDEKICK_SERVER_URL, undefined, 'does not seed serverUrl when SIDEKICK_URL is set');
  });
});
test('applyConfigToEnv encodes openvino.enabled=false as "false"', () => {
  withCleanEnv({}, () => {
    cfg.applyConfigToEnv({ openvino: { enabled: false } });
    assert.strictEqual(process.env.SIDEKICK_OPENVINO_ENABLED, 'false');
  });
});
test('applyConfigToEnv skips ollama.url when ollama.enabled is false', () => {
  withCleanEnv({}, () => {
    cfg.applyConfigToEnv({ ollama: { enabled: false, url: 'http://x:11434' } });
    assert.strictEqual(process.env.OLLAMA_URL, undefined);
  });
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
