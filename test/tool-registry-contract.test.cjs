const assert = require('assert');
const fs = require('fs');

const legacyTools = require('../src/tools');
const toolLayer = require('../src/tools/index');

const toolsFacadeSource = fs.readFileSync('src/tools.js', 'utf8');
const indexSource = fs.readFileSync('src/index.js', 'utf8');

console.log('Running Tool Registry Contract Tests...');

const registry = toolLayer.getBuiltinRegistry();
const descriptors = registry.listInDefinitionOrder();
const descriptorNames = descriptors.map(d => d.name);
const legacyDefNames = legacyTools.TOOL_DEFS.map(d => d.name);
const legacyToolNames = Object.keys(legacyTools.TOOLS);

assert.deepStrictEqual(descriptorNames, legacyDefNames, 'Registry definition order should match legacy TOOL_DEFS order');
assert.deepStrictEqual([...descriptorNames].sort(), [...legacyToolNames].sort(), 'Registry names should match legacy TOOLS keys');
assert.strictEqual(descriptors.length, 107, 'Built-in tool count should remain at the current-main baseline');

for (const descriptor of descriptors) {
  assert.strictEqual(typeof descriptor.name, 'string', `${descriptor.name} should have a name`);
  assert.strictEqual(typeof descriptor.description, 'string', `${descriptor.name} should have a description`);
  assert.ok(descriptor.description.length > 0, `${descriptor.name} description should be non-empty`);
  assert.strictEqual(typeof descriptor.handler, 'function', `${descriptor.name} should have a handler`);
  assert.ok(descriptor.schema && typeof descriptor.schema.safeParse === 'function', `${descriptor.name} should have a Zod schema`);
  assert.ok(['low', 'medium', 'high', 'critical'].includes(descriptor.risk), `${descriptor.name} should have a valid risk`);
  assert.ok(descriptor.category, `${descriptor.name} should have a category`);
  assert.deepStrictEqual(descriptor.args, legacyTools.TOOL_DEFS.find(d => d.name === descriptor.name).args || {}, `${descriptor.name} args metadata should match legacy TOOL_DEFS`);
  assert.strictEqual(descriptor.risk, legacyTools.getToolRisk(descriptor.name), `${descriptor.name} risk should match legacy lookup`);
  assert.strictEqual(descriptor.handler, legacyTools.TOOLS[descriptor.name], `${descriptor.name} handler should match legacy TOOLS`);
}

assert.deepStrictEqual(Object.keys(registry.toolsMap()), legacyDefNames, 'Derived TOOLS map should preserve definition order');
assert.deepStrictEqual(registry.toolDefs().map(d => d.name), legacyDefNames, 'Derived TOOL_DEFS should preserve definition order');
assert.deepStrictEqual(Object.keys(registry.schemas()), legacyDefNames, 'Derived schema map should preserve definition order');

assert.ok(registry.has('sidekick_read'), 'Registry should normalize sidekick_ prefix for has()');
assert.strictEqual(registry.get('sidekick_read').name, 'read', 'Registry should normalize sidekick_ prefix for get()');

assert.strictEqual(toolLayer.dispatcher.callTool, legacyTools.callTool, 'Dispatcher should delegate to compatibility callTool during extraction');
assert.strictEqual(toolLayer.policy.enforceToolPolicy, legacyTools.enforceToolPolicy, 'Policy module should preserve enforcement behavior');
assert.strictEqual(toolLayer.policy.getToolRisk, legacyTools.getToolRisk, 'Policy module should preserve risk lookup');
assert.strictEqual(toolLayer.approvals.getApprovalDecision, legacyTools.getApprovalDecision, 'Approvals module should preserve approval decisions');
assert.strictEqual(toolLayer.logging.logToolCall, legacyTools.logToolCall, 'Logging module should preserve tool-call logging');
assert.strictEqual(toolLayer.registrySync.syncToolRegistry, legacyTools.syncToolRegistry, 'Registry sync module should preserve DB sync behavior');
assert.deepStrictEqual(toolLayer.result.textResult('ok'), { content: [{ type: 'text', text: 'ok' }] }, 'Result helper should create MCP text content');
assert.strictEqual(toolLayer.context.getExecutionSource(), 'mcp', 'New execution context should default to mcp');
assert.ok(toolsFacadeSource.split(/\r?\n/).length < 30, 'src/tools.js should remain a small compatibility facade');
assert.ok(!indexSource.includes('const TOOL_SCHEMAS = {'), 'src/index.js should not own an independent TOOL_SCHEMAS catalog');
assert.ok(indexSource.includes('getBuiltinRegistry'), 'src/index.js should register built-ins from the canonical registry');

const exportedNames = Object.keys(legacyTools).sort();
assert.deepStrictEqual(exportedNames, [
  'DATA_DIR', 'GROQ_API_KEY', 'GROQ_MODEL', 'OLLAMA_URL', 'TOOLS', 'TOOL_DEFS',
  'appendScheduledPlatformEvent', 'buildCiStatusResult', 'buildPolicyInspection',
  'callTool', 'checkNetwork', 'createScheduledPlatformExecution', 'enforceToolPolicy',
  'formatCiStatusText', 'getApprovalDecision', 'getCiRevisionSelector', 'getGithubArg',
  'getToolCategoriesWithTools', 'getToolDefsForSource', 'getToolPolicyDecision',
  'getToolRisk', 'isDangerous', 'listApprovals', 'loadDelays', 'loadProcedures',
  'loadWatches', 'logToolCall', 'missionRoute', 'parseGithubArgs', 'resolveApproval',
  'saveDelays', 'saveWatches', 'setSource', 'summarizePolicyInspection',
  'syncToolRegistry', 'transitionScheduledPlatformExecution'
].sort(), 'src/tools.js compatibility export set should remain stable');

console.log('Tool Registry Contract Tests passed');
