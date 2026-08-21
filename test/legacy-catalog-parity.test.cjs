const assert = require('assert');

const catalog = require('../src/tools/legacy-catalog');
const { getCanonicalRegistry } = require('../src/tools/canonical-registry');
const legacy = require('../src/tools-legacy');

assert.strictEqual(legacy.TOOL_DEFS, catalog.TOOL_DEFS, 'legacy facade should export the catalog array');
assert.deepStrictEqual(
  catalog.TOOL_DEFS,
  getCanonicalRegistry().toolDefs(),
  'legacy catalog must be a projection of canonical descriptors'
);
assert.deepStrictEqual(
  legacy.TOOL_DEFS.map(def => def.name),
  catalog.TOOL_DEFS.map(def => def.name),
  'catalog extraction must preserve definition order'
);
assert.strictEqual(
  new Set(catalog.TOOL_DEFS.map(def => def.name)).size,
  catalog.TOOL_DEFS.length,
  'catalog tool names must remain unique'
);

console.log('Legacy catalog parity passed');
