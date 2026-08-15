const assert = require('assert');

const catalog = require('../src/tools/legacy-catalog');
const legacy = require('../src/tools-legacy');

assert.strictEqual(legacy.TOOL_DEFS, catalog.TOOL_DEFS, 'legacy facade should export the catalog array');
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
