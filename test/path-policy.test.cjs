const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-path-policy');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'path-policy-test-secret-key';

const PATH_ENV_KEYS = [
  'SIDEKICK_ALLOWED_PATHS',
  'SIDEKICK_DENIED_PATHS',
  'SIDEKICK_AGENT_ALLOWED_PATHS',
  'SIDEKICK_AGENT_DENIED_PATHS',
  'SIDEKICK_MCP_ALLOWED_PATHS',
  'SIDEKICK_MCP_DENIED_PATHS'
];
for (const key of PATH_ENV_KEYS) delete process.env[key];

const pathPolicy = require('../src/tools/path-policy');
const toolContext = require('../src/tools/context');
const { parsePolicyList, sourceEnvName } = require('../src/core/policy-env');
const legacy = require('../src/tools-legacy');
const tools = require('../src/tools');

const {
  normalizePolicyPath,
  pathMatchesPolicyEntry,
  getPathPolicyDecision,
  enforcePathPolicy
} = pathPolicy;

console.log('Running Path Policy Tests...');

const allowedDir = path.join(TEST_DATA_DIR, 'allowed');
const deniedDir = path.join(allowedDir, 'denied');
const outsideDir = path.join(TEST_DATA_DIR, 'outside');
// Sibling whose name is a string prefix of the allowed root; a naive
// startsWith() containment check would wrongly permit this.
const prefixSiblingDir = path.join(TEST_DATA_DIR, 'allowed-evil');
for (const dir of [allowedDir, deniedDir, outsideDir, prefixSiblingDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
const allowedFile = path.join(allowedDir, 'ok.txt');
const deniedFile = path.join(deniedDir, 'secret.txt');
const outsideFile = path.join(outsideDir, 'outside.txt');
const prefixSiblingFile = path.join(prefixSiblingDir, 'evil.txt');
fs.writeFileSync(allowedFile, 'allowed content', 'utf-8');
fs.writeFileSync(deniedFile, 'denied content', 'utf-8');
fs.writeFileSync(outsideFile, 'outside content', 'utf-8');
fs.writeFileSync(prefixSiblingFile, 'evil content', 'utf-8');

function resetPathEnv() {
  for (const key of PATH_ENV_KEYS) delete process.env[key];
}

(async () => {
  try {
    // --- Boundary: the shared module is the authoritative implementation ---

    console.log('Test 1: module boundary and exports');
    assert.strictEqual(typeof enforcePathPolicy, 'function', 'path-policy should export enforcePathPolicy');
    assert.strictEqual(typeof getPathPolicyDecision, 'function', 'path-policy should export getPathPolicyDecision');
    // There must be exactly one definition of the boundary anywhere under src/.
    // Covers function declarations, const/let/var assignment, object-property
    // function/arrow values, and ES6 method shorthand, so a re-introduced copy
    // cannot slip past by changing its declaration form.
    const srcRoot = path.join(__dirname, '..', 'src');
    const srcFiles = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|cjs|mjs)$/.test(entry.name)) srcFiles.push(full);
      }
    })(srcRoot);

    for (const fnName of ['enforcePathPolicy', 'getPathPolicyDecision', 'pathMatchesPolicyEntry']) {
      const definitionPattern = new RegExp(
        [
          `function\\s+${fnName}\\s*\\(`,                                                  // declaration
          `(?:const|let|var)\\s+${fnName}\\s*=`,                                            // assignment
          `exports\\.${fnName}\\s*=`,                                                       // exports assignment
          `^\\s*(?:async\\s+)?${fnName}\\s*\\([^)]*\\)\\s*\\{`,                             // method shorthand
          `^\\s*${fnName}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)` // property value
        ].join('|'),
        'm'
      );
      const definers = srcFiles.filter(file => definitionPattern.test(fs.readFileSync(file, 'utf8')));
      assert.deepStrictEqual(
        definers.map(f => path.relative(srcRoot, f)),
        [path.join('tools', 'path-policy.js')],
        `${fnName} must have exactly one definition, in the shared path policy module`
      );
    }

    const legacySource = fs.readFileSync(path.join(srcRoot, 'tools-legacy.js'), 'utf8');
    assert.ok(
      /require\("\.\/tools\/path-policy"\)/.test(legacySource),
      'tools-legacy.js should consume the shared path policy module'
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(legacy, 'enforcePathPolicy'),
      'enforcePathPolicy had no legacy export before extraction and should not gain one'
    );
    console.log('✓ Passed\n');

    console.log('Test 2: open by default when no policy is configured');
    resetPathEnv();
    toolContext.setExecutionSource('mcp');
    const openDecision = getPathPolicyDecision(outsideFile, 'read');
    assert.strictEqual(openDecision.allowed, true, 'Unset policy should allow everything');
    assert.strictEqual(openDecision.reason, 'path policy is open');
    assert.strictEqual(openDecision.operation, 'read');
    assert.strictEqual(openDecision.source, 'mcp');
    assert.strictEqual(openDecision.path, path.resolve(outsideFile));
    assert.strictEqual(enforcePathPolicy(outsideFile, 'read'), null, 'Allowed path should enforce to null');
    console.log('✓ Passed\n');

    console.log('Test 3: allow list permits members and blocks non-members');
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = allowedDir;
    const allowHit = getPathPolicyDecision(allowedFile, 'read');
    assert.strictEqual(allowHit.allowed, true, 'Path inside allow root should be permitted');
    assert.strictEqual(allowHit.reason, 'path allowed by policy');
    assert.strictEqual(allowHit.list, 'allowed');
    assert.strictEqual(allowHit.matched, allowedDir, 'Decision should report the matched entry');

    const allowMiss = getPathPolicyDecision(outsideFile, 'read');
    assert.strictEqual(allowMiss.allowed, false, 'Path outside allow root should be blocked');
    assert.strictEqual(allowMiss.reason, 'path not in allowed paths');
    assert.strictEqual(allowMiss.list, 'allowed');
    assert.strictEqual(allowMiss.matched, null, 'Non-matching allow decision should report a null match');

    // The allow root itself resolves to relative === "" and must be permitted.
    assert.strictEqual(getPathPolicyDecision(allowedDir, 'read').allowed, true, 'Allow root itself should be permitted');
    console.log('✓ Passed\n');

    console.log('Test 4: deny list wins over allow list');
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = TEST_DATA_DIR;
    process.env.SIDEKICK_DENIED_PATHS = deniedDir;
    const denyDecision = getPathPolicyDecision(deniedFile, 'read');
    assert.strictEqual(denyDecision.allowed, false, 'Deny should win even when the path is inside an allow root');
    assert.strictEqual(denyDecision.reason, 'path denied by policy');
    assert.strictEqual(denyDecision.list, 'denied');
    assert.strictEqual(denyDecision.matched, deniedDir);
    // A sibling of the denied dir, still inside the allow root, stays allowed.
    assert.strictEqual(getPathPolicyDecision(allowedFile, 'read').allowed, true, 'Deny should not over-block siblings');
    console.log('✓ Passed\n');

    console.log('Test 5: traversal and prefix-collision escapes are rejected');
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = allowedDir;
    const traversal = path.join(allowedDir, '..', 'outside', 'outside.txt');
    const traversalDecision = getPathPolicyDecision(traversal, 'read');
    assert.strictEqual(traversalDecision.allowed, false, 'Traversal out of the allow root should be blocked');
    assert.strictEqual(
      traversalDecision.path,
      path.resolve(outsideFile),
      'Traversal segments should be normalized away before the decision'
    );

    const prefixDecision = getPathPolicyDecision(prefixSiblingFile, 'read');
    assert.strictEqual(prefixDecision.allowed, false, 'Sibling sharing a name prefix with the allow root must not be permitted');
    assert.strictEqual(pathMatchesPolicyEntry(prefixSiblingFile, allowedDir), false, 'Containment must not be a string prefix test');

    // Deny side of the same escape: traversal cannot dodge a deny root.
    resetPathEnv();
    process.env.SIDEKICK_DENIED_PATHS = deniedDir;
    const dodge = path.join(allowedDir, 'ok', '..', 'denied', 'secret.txt');
    assert.strictEqual(getPathPolicyDecision(dodge, 'read').allowed, false, 'Traversal must not dodge a deny root');
    console.log('✓ Passed\n');

    console.log('Test 6: relative, nonexistent, and empty inputs');
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = process.cwd();
    const relativeDecision = getPathPolicyDecision('package.json', 'read');
    assert.strictEqual(relativeDecision.allowed, true, 'Relative paths resolve against cwd');
    assert.strictEqual(relativeDecision.path, path.resolve('package.json'), 'Relative input should be resolved to absolute');

    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = allowedDir;
    const missing = path.join(allowedDir, 'does-not-exist', 'file.txt');
    assert.strictEqual(fs.existsSync(missing), false, 'Fixture must not exist');
    assert.strictEqual(
      getPathPolicyDecision(missing, 'write').allowed,
      true,
      'Policy decides on the resolved path without requiring the target to exist'
    );
    assert.strictEqual(
      getPathPolicyDecision(path.join(outsideDir, 'nope.txt'), 'write').allowed,
      false,
      'Nonexistent paths outside the allow root are still blocked'
    );
    // Preserved quirk: empty/undefined input resolves to the current directory.
    assert.strictEqual(normalizePolicyPath(''), path.resolve(''), 'Empty path resolves to cwd');
    assert.strictEqual(normalizePolicyPath(undefined), path.resolve(''), 'Undefined path resolves to cwd');
    console.log('✓ Passed\n');

    console.log('Test 7: per-source policy isolation');
    resetPathEnv();
    process.env.SIDEKICK_AGENT_ALLOWED_PATHS = allowedDir;
    toolContext.setExecutionSource('agent');
    const agentDecision = getPathPolicyDecision(outsideFile, 'read');
    assert.strictEqual(agentDecision.allowed, false, 'Source-specific allow list should constrain that source');
    assert.strictEqual(agentDecision.source, 'agent', 'Decision should report the resolved execution source');

    toolContext.setExecutionSource('mcp');
    assert.strictEqual(
      getPathPolicyDecision(outsideFile, 'read').allowed,
      true,
      'Source-specific allow list should not affect other sources'
    );

    // An explicit source argument overrides the ambient context.
    assert.strictEqual(
      getPathPolicyDecision(outsideFile, 'read', 'agent').allowed,
      false,
      'Explicit source argument should be honored'
    );

    // Global and source-specific lists union rather than replace.
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = allowedDir;
    process.env.SIDEKICK_AGENT_ALLOWED_PATHS = outsideDir;
    toolContext.setExecutionSource('agent');
    assert.strictEqual(getPathPolicyDecision(allowedFile, 'read').allowed, true, 'Global allow entry applies to every source');
    assert.strictEqual(getPathPolicyDecision(outsideFile, 'read').allowed, true, 'Source allow entry unions with the global list');
    toolContext.setExecutionSource('mcp');
    assert.strictEqual(getPathPolicyDecision(outsideFile, 'read').allowed, false, 'Source entry should not leak to another source');
    console.log('✓ Passed\n');

    console.log('Test 8: legacy setSource compatibility still drives the policy');
    resetPathEnv();
    process.env.SIDEKICK_AGENT_DENIED_PATHS = deniedDir;
    legacy.setSource('agent');
    assert.strictEqual(getPathPolicyDecision(deniedFile, 'read').allowed, false, 'legacy setSource should reach the extracted module');
    legacy.setSource('mcp');
    assert.strictEqual(getPathPolicyDecision(deniedFile, 'read').allowed, true, 'legacy setSource should switch the resolved source back');
    console.log('✓ Passed\n');

    console.log('Test 9: environment is re-read on every call');
    resetPathEnv();
    toolContext.setExecutionSource('mcp');
    assert.strictEqual(getPathPolicyDecision(outsideFile, 'read').allowed, true, 'Open before configuration');
    process.env.SIDEKICK_DENIED_PATHS = outsideDir;
    assert.strictEqual(getPathPolicyDecision(outsideFile, 'read').allowed, false, 'Newly set deny list applies without a reload');
    delete process.env.SIDEKICK_DENIED_PATHS;
    assert.strictEqual(getPathPolicyDecision(outsideFile, 'read').allowed, true, 'Cleared deny list applies without a reload');
    // Comma-separated lists with whitespace and empty members.
    process.env.SIDEKICK_DENIED_PATHS = `  ${outsideDir} , , ${deniedDir}  `;
    assert.strictEqual(getPathPolicyDecision(outsideFile, 'read').allowed, false, 'Whitespace-padded list members should be honored');
    assert.strictEqual(getPathPolicyDecision(deniedFile, 'read').allowed, false, 'Later list members should be honored');
    assert.deepStrictEqual(parsePolicyList('  a , , b  '), ['a', 'b'], 'parsePolicyList trims and drops empties');
    assert.strictEqual(sourceEnvName('agent', 'ALLOWED_PATHS'), 'SIDEKICK_AGENT_ALLOWED_PATHS');
    assert.strictEqual(sourceEnvName('my-source', 'DENIED_PATHS'), 'SIDEKICK_MY_SOURCE_DENIED_PATHS', 'Non-alphanumerics collapse to underscore');
    console.log('✓ Passed\n');

    console.log('Test 10: blocked error shape and message are unchanged');
    resetPathEnv();
    toolContext.setExecutionSource('mcp');
    process.env.SIDEKICK_ALLOWED_PATHS = allowedDir;
    const blocked = enforcePathPolicy(outsideFile, 'write');
    assert.ok(blocked && blocked.isError === true, 'Blocked path should produce an isError result');
    assert.strictEqual(blocked.content.length, 1);
    assert.strictEqual(blocked.content[0].type, 'text');
    assert.strictEqual(
      blocked.content[0].text,
      `Path blocked by policy: ${path.resolve(outsideFile)} (source=mcp, operation=write). path not in allowed paths.`,
      'Blocked message text is asserted by other suites and must not drift'
    );
    // Default operation label.
    assert.ok(
      enforcePathPolicy(outsideFile).content[0].text.includes('operation=access'),
      'Default operation should remain "access"'
    );
    // Deny reason wording.
    resetPathEnv();
    process.env.SIDEKICK_DENIED_PATHS = deniedDir;
    assert.ok(
      enforcePathPolicy(deniedFile, 'delete').content[0].text.endsWith('(source=mcp, operation=delete). path denied by policy.'),
      'Deny reason wording must not drift'
    );
    console.log('✓ Passed\n');

    console.log('Test 11: integration through the legacy handlers');
    resetPathEnv();
    toolContext.setExecutionSource('mcp');
    process.env.SIDEKICK_ALLOWED_PATHS = allowedDir;
    const readOk = await tools.TOOLS.read({ path: allowedFile });
    assert.ok(!readOk.isError, 'Allowed read should succeed through the tool surface');

    const readBlocked = await tools.TOOLS.read({ path: outsideFile });
    assert.ok(readBlocked.isError, 'Read outside the allow root should be blocked');
    assert.ok(readBlocked.content[0].text.includes('Path blocked by policy'), 'Handler should surface the shared policy message');

    const writeBlocked = await tools.TOOLS.write({ path: outsideFile, content: 'should not land' });
    assert.ok(writeBlocked.isError, 'Blocked write should return an error');
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf-8'), 'outside content', 'Blocked write must not mutate the target');

    // hash still routes through the shared boundary and stays legacy-owned.
    const hashBlocked = await tools.TOOLS.hash({ path: outsideFile });
    assert.ok(hashBlocked.isError, 'hash should still enforce the shared path policy');
    assert.ok(hashBlocked.content[0].text.includes('Path blocked by policy'), 'hash should surface the shared policy message');
    const hashOk = await tools.TOOLS.hash({ path: allowedFile });
    assert.ok(!hashOk.isError, 'hash should still succeed for an allowed path');
    console.log('✓ Passed\n');

    resetPathEnv();
    toolContext.setExecutionSource('mcp');
    console.log('All path policy tests passed.');
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
