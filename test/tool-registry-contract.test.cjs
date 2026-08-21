const assert = require('assert');
const fs = require('fs');

const legacyTools = require('../src/tools');
const toolLayer = require('../src/tools/index');
const extractedFamilies = require('../src/tools/families');
const canonical = require('../src/tools/canonical-registry');

// Names owned by extracted descriptor families rather than by legacy handlers.
const extractedNames = extractedFamilies.descriptors.map(d => d.name);

const toolsFacadeSource = fs.readFileSync('src/tools.js', 'utf8');
const mcpServerSource = fs.readFileSync('src/mcp/server.js', 'utf8');

console.log('Running Tool Registry Contract Tests...');

const registry = toolLayer.getBuiltinRegistry();
const descriptors = registry.listInDefinitionOrder();
const descriptorNames = descriptors.map(d => d.name);
const legacy = require('../src/tools-legacy');
const legacyDefNames = legacy.TOOL_DEFS.map(d => d.name);
const legacyToolNames = Object.keys(legacy.TOOLS);

assert.deepStrictEqual(descriptorNames, legacyDefNames, 'Registry definition order should match legacy TOOL_DEFS order');
assert.deepStrictEqual(descriptorNames, canonical.getCanonicalRegistry().toolDefs().map(d => d.name), 'builtin registry must be canonical');
assert.deepStrictEqual([...descriptorNames].sort(), [...new Set([...legacyToolNames, ...extractedNames])].sort(), 'Registry names should match legacy handlers plus extracted descriptors');
// Baseline moves only when a tool is deliberately added or removed.
// Capability Packs v1 added `capability` (pack lifecycle) and `workflow`
// (workflow definition registry + runner): 103 -> 105. B7 connector authority
// added `connector` (read-only connector inspection): 105 -> 106. The
// workspace surface added `workspace` (workspaces + encrypted secrets):
// 106 -> 107. Governed Browser Automation added `browser` (Core browser
// subsystem surface): 107 -> 108.
assert.strictEqual(descriptors.length, 108, 'Built-in tool count should remain at the current-main baseline');

for (const descriptor of descriptors) {
  assert.strictEqual(typeof descriptor.name, 'string', `${descriptor.name} should have a name`);
  assert.strictEqual(typeof descriptor.description, 'string', `${descriptor.name} should have a description`);
  assert.ok(descriptor.description.length > 0, `${descriptor.name} description should be non-empty`);
  assert.strictEqual(typeof descriptor.handler, 'function', `${descriptor.name} should have a handler`);
  assert.ok(descriptor.schema && typeof descriptor.schema.safeParse === 'function', `${descriptor.name} should have a Zod schema`);
  assert.ok(['low', 'medium', 'high', 'critical'].includes(descriptor.risk), `${descriptor.name} should have a valid risk`);
  assert.ok(descriptor.category, `${descriptor.name} should have a category`);
  assert.deepStrictEqual(descriptor.args, legacy.TOOL_DEFS.find(d => d.name === descriptor.name).args || {}, `${descriptor.name} args metadata should match compatibility TOOL_DEFS`);
  assert.strictEqual(descriptor.risk, legacyTools.getToolRisk(descriptor.name), `${descriptor.name} risk should match compatibility lookup`);
  if (!descriptor.family) assert.strictEqual(descriptor.handler, legacy.TOOLS[descriptor.name], `${descriptor.name} handler should match legacy TOOLS until extracted`);
}

for (const name of ['compute', 'compute_nodes', 'compute_providers', 'compute_models', 'compute_jobs', 'compute_route']) {
  assert.strictEqual(canonical.getCanonicalRegistry().get(name).family, 'compute', `${name} should be canonically descriptor-owned`);
  assert.ok(!require('../src/tools/legacy-tool-map').TOOLS[name] || typeof require('../src/tools/legacy-tool-map').TOOLS[name] === 'function', `${name} compatibility projection should remain callable`);
}

assert.deepStrictEqual(Object.keys(registry.toolsMap()), legacyDefNames, 'Derived TOOLS map should preserve definition order');
assert.deepStrictEqual(registry.toolDefs().map(d => d.name), legacyDefNames, 'Derived TOOL_DEFS should preserve definition order');
assert.deepStrictEqual(Object.keys(registry.schemas()), legacyDefNames, 'Derived schema map should preserve definition order');

assert.ok(registry.has('sidekick_read'), 'Registry should normalize sidekick_ prefix for has()');
assert.strictEqual(registry.get('sidekick_read').name, 'read', 'Registry should normalize sidekick_ prefix for get()');

assert.notStrictEqual(toolLayer.dispatcher.callTool, legacy.callTool, 'Dispatcher should own execution instead of delegating to legacy callTool');
assert.strictEqual(legacyTools.callTool, toolLayer.dispatcher.callTool, 'Compatibility callTool should route to the dispatcher');
assert.strictEqual(toolLayer.policy.enforceToolPolicy, legacyTools.enforceToolPolicy, 'Policy module should preserve enforcement behavior');
assert.strictEqual(toolLayer.policy.getToolRisk, legacyTools.getToolRisk, 'Policy module should preserve risk lookup');
assert.strictEqual(toolLayer.approvals.getApprovalDecision, legacyTools.getApprovalDecision, 'Approvals module should preserve approval decisions');
assert.strictEqual(toolLayer.logging.logToolCall, legacyTools.logToolCall, 'Logging module should preserve tool-call logging');
assert.strictEqual(toolLayer.registrySync.syncToolRegistry, legacyTools.syncToolRegistry, 'Registry sync module should preserve DB sync behavior');
assert.deepStrictEqual(toolLayer.result.textResult('ok'), { content: [{ type: 'text', text: 'ok' }] }, 'Result helper should create MCP text content');
assert.strictEqual(toolLayer.context.getExecutionSource(), 'mcp', 'New execution context should default to mcp');
assert.ok(toolsFacadeSource.includes('require("./tools/index")'), 'src/tools.js should facade to the new tool layer');
assert.ok(toolsFacadeSource.split(/\r?\n/).length < 10, 'src/tools.js should remain a small compatibility facade');
assert.ok(!mcpServerSource.includes('const TOOL_SCHEMAS = {'), 'MCP server should not own an independent TOOL_SCHEMAS catalog');
assert.ok(mcpServerSource.includes('getBuiltinRegistry'), 'MCP server should register built-ins from the canonical registry');
assert.ok(mcpServerSource.includes('callMcpTool(descriptor.name'), 'MCP built-in execution should route through the MCP dispatcher wrapper');
assert.ok(!mcpServerSource.includes('descriptor.handler(args)'), 'MCP must not directly invoke built-in handlers');
assert.strictEqual(registry.get('respond').family, 'utility', 'respond should be owned by extracted utility family');
// data-utilities moved to the module system (src/modules/entries/data-utilities.js):
// its tools are absent from the builtin registry until the module is
// provisioned (covered by test/modules-builtin.test.js).
for (const name of ['parse', 'diff', 'validate', 'template', 'transform', 'extract']) {
  assert.ok(!registry.has(name), `${name} should be module-owned, not builtin`);
  assert.ok(!legacyDefNames.includes(name), `${name} should no longer have a legacy TOOL_DEFS row`);
}
for (const name of extractedNames) {
  assert.ok(!legacy.TOOLS[name], `${name} should no longer have an active legacy handler`);
  assert.ok(legacyDefNames.includes(name), `${name} should keep its legacy TOOL_DEFS row as an ordering anchor`);
}

assert.strictEqual(registry.get('hash').family, 'hashing', 'hash should be owned by the hashing family');
assert.strictEqual(registry.get('hash').category, 'Data Pipeline', 'hash should retain its category');
assert.strictEqual(registry.get('hash').source, 'builtin', 'hash should be a descriptor-owned builtin');
assert.ok(!legacy.TOOLS.hash, 'hash should no longer have an active legacy handler');

// One schema owner per extracted descriptor: a descriptor's schema lives in its
// family, never duplicated in the legacy TOOL_SCHEMAS catalog. The storage
// family (store/get/delete/list_projects/get_by_project) is the current
// baseline that removed its duplicates.
const toolSchemas = require('../src/tools/schemas').TOOL_SCHEMAS;
for (const name of extractedNames) {
  assert.ok(!Object.prototype.hasOwnProperty.call(toolSchemas, name), `${name} should have no duplicate legacy schema`);
}

const exportedNames = Object.keys(legacyTools).sort();
for (const name of [
  'DATA_DIR', 'GROQ_API_KEY', 'GROQ_MODEL', 'OLLAMA_URL', 'TOOLS', 'TOOL_DEFS',
  'appendScheduledPlatformEvent', 'buildCiStatusResult', 'buildPolicyInspection',
  'callTool', 'checkNetwork', 'createScheduledPlatformExecution', 'enforceToolPolicy',
  'formatCiStatusText', 'getApprovalDecision', 'getCiRevisionSelector', 'getGithubArg',
  'getToolCategoriesWithTools', 'getToolDefsForSource', 'getToolPolicyDecision',
  'getToolRisk', 'isDangerous', 'listApprovals', 'loadDelays', 'loadProcedures',
  'loadWatches', 'logToolCall', 'missionRoute', 'parseGithubArgs', 'resolveApproval',
  'saveDelays', 'saveWatches', 'setSource', 'summarizePolicyInspection',
  'syncToolRegistry', 'transitionScheduledPlatformExecution'
]) {
  assert.ok(exportedNames.includes(name), `src/tools.js compatibility export should include ${name}`);
}

console.log('Tool Registry Contract Tests passed');
