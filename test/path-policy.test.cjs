const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

// --- Symlink fixtures ---
//
// These live outside TEST_DATA_DIR, in the OS temp directory, because the
// repository checkout may sit on a filesystem that cannot support symlinks.
// Under WSL a /mnt/c (drvfs) checkout accepts symlinkSync but the resulting
// link cannot be stat'd, which would produce misleading failures. The temp
// directory is native. Its own path is canonicalized up front so the fixtures
// are compared against a stable root (macOS resolves /tmp to /private/tmp).
let LINK_ROOT = null;
let symlinkSupport = null; // null = unknown, true = usable, Error = unusable

function cleanupLinkRoot() {
  if (LINK_ROOT) fs.rmSync(LINK_ROOT, { recursive: true, force: true });
  LINK_ROOT = null;
}

function setupSymlinkFixtures() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-path-policy-')));
  LINK_ROOT = root;
  const at = (...parts) => path.join(root, ...parts);

  for (const dir of ['safe', 'safe/inner', 'outside', 'secrets', 'secrets/sub']) {
    fs.mkdirSync(at(...dir.split('/')), { recursive: true });
  }
  fs.writeFileSync(at('outside', 'secret.txt'), 'outside secret', 'utf-8');
  fs.writeFileSync(at('safe', 'plain.txt'), 'safe content', 'utf-8');
  fs.writeFileSync(at('safe', 'inner', 'real.txt'), 'inner content', 'utf-8');
  fs.writeFileSync(at('secrets', 'top.txt'), 'denied content', 'utf-8');
  fs.writeFileSync(at('secrets', 'sub', 'nested.txt'), 'denied nested', 'utf-8');

  // Probe support before building the rest; a failure here is reported, never
  // silently swallowed into a pass.
  try {
    fs.symlinkSync(at('outside', 'secret.txt'), at('safe', 'escape-file'));
    fs.realpathSync(at('safe', 'escape-file'));
  } catch (error) {
    symlinkSupport = error;
    return;
  }

  fs.symlinkSync(at('outside'), at('safe', 'escape-dir'));          // dir escape
  fs.symlinkSync(at('safe', 'hop2'), at('safe', 'hop1'));           // multi-hop...
  fs.symlinkSync(at('outside'), at('safe', 'hop2'));                // ...eventual escape
  fs.symlinkSync(at('safe', 'inner'), at('safe', 'inner-link'));    // stays inside
  fs.symlinkSync(at('secrets'), at('safe', 'deny-dir'));            // alias into deny root
  fs.symlinkSync(at('secrets', 'top.txt'), at('safe', 'deny-file'));
  fs.symlinkSync(at('safe', 'nowhere'), at('safe', 'broken'));      // dangling
  fs.symlinkSync(at('safe', 'nowhere-dir'), at('safe', 'broken-dir'));
  fs.symlinkSync(at('safe'), at('linked-root'));                    // symlinked allow root
  fs.symlinkSync(at('outside'), at('secrets', 'escape'));           // out of a deny root
  fs.symlinkSync(at('outside', 'nowhere'), at('outside', 'stray-broken'));
  fs.symlinkSync(at('secrets', 'nowhere'), at('secrets', 'dangling-inside'));
  symlinkSupport = true;
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

    // --- Symlink resolution: a path must be judged by where it points ---

    console.log('Test 12: symlink fixture support');
    setupSymlinkFixtures();
    if (symlinkSupport !== true) {
      console.error('✗ Symlinks are not usable in the OS temp directory of this environment.');
      console.error(`  ${symlinkSupport && symlinkSupport.message}`);
      console.error('  Tests 13-18 verify the symlink-escape fix and cannot run here.');
      throw new Error('symlink fixtures unavailable; symlink policy tests did not run');
    }
    const at = (...parts) => path.join(LINK_ROOT, ...parts);
    // path.join collapses ".." lexically, which is exactly the collapsing these
    // tests need to avoid, so ".." cases are built as raw strings.
    const rawAt = (...parts) => `${LINK_ROOT}/${parts.join('/')}`;
    const safeRoot = at('safe');
    const denyRoot = at('secrets');
    console.log('✓ Passed\n');

    console.log('Test 13: symlinks cannot escape an allow root');
    resetPathEnv();
    toolContext.setExecutionSource('mcp');
    process.env.SIDEKICK_ALLOWED_PATHS = safeRoot;

    // Baseline: a real file under the allow root is still permitted.
    assert.strictEqual(getPathPolicyDecision(at('safe', 'plain.txt'), 'read').allowed, true, 'Plain file under the allow root stays permitted');

    // A link inside the allow root pointing at a file outside it.
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'escape-file'), 'read').allowed,
      false,
      'Symlink to a file outside the allow root must be denied'
    );
    // A linked directory inside the allow root; children of it are outside.
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'escape-dir', 'secret.txt'), 'read').allowed,
      false,
      'File under a symlinked directory that escapes the allow root must be denied'
    );
    // Several hops that eventually land outside.
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'hop1', 'secret.txt'), 'read').allowed,
      false,
      'Multi-hop symlink chain escaping the allow root must be denied'
    );
    // ".." after a symlink component must be applied to the link's target, the
    // way the kernel applies it. Collapsing it lexically first erases the link:
    // safe/escape-dir/../outside/secret.txt normalizes to safe/outside/... —
    // apparently inside the allow root — while the kernel reads outside/... .
    assert.strictEqual(
      getPathPolicyDecision(rawAt('safe', 'escape-dir', '..', 'outside', 'secret.txt'), 'read').allowed,
      false,
      '".." after an escaping symlink must not be collapsed lexically'
    );
    assert.strictEqual(
      getPathPolicyDecision(rawAt('safe', 'hop1', '..', 'outside', 'secret.txt'), 'read').allowed,
      false,
      '".." after a multi-hop symlink chain must not be collapsed lexically'
    );
    // The same escapes spelled relative to the current directory. Absolutizing
    // a relative path must not normalize it, or the ".." collapses before it
    // can be resolved and every escape above reopens.
    const relRoot = path.relative(process.cwd(), LINK_ROOT);
    const relAt = (...parts) => `${relRoot}/${parts.join('/')}`;
    assert.strictEqual(
      getPathPolicyDecision(relAt('safe', 'escape-dir', '..', 'outside', 'secret.txt'), 'read').allowed,
      false,
      'Relative spelling of a ".."-after-symlink escape must also be denied'
    );
    assert.strictEqual(
      getPathPolicyDecision(relAt('safe', 'escape-file'), 'read').allowed,
      false,
      'Relative spelling of a plain symlink escape must also be denied'
    );
    assert.strictEqual(
      getPathPolicyDecision(relAt('safe', 'plain.txt'), 'read').allowed,
      true,
      'Relative spelling of a permitted path still resolves correctly'
    );

    // A relative path containing no ".." takes a different resolution branch,
    // so it needs its own coverage. relRoot above always contains ".." (the
    // fixtures are on a different filesystem from the checkout), which would
    // otherwise leave this branch untested.
    const previousCwd = process.cwd();
    try {
      process.chdir(safeRoot);
      assert.strictEqual(
        getPathPolicyDecision('escape-file', 'read').allowed,
        false,
        'Relative path with no ".." must still resolve its symlink'
      );
      assert.strictEqual(
        getPathPolicyDecision(path.join('escape-dir', 'secret.txt'), 'read').allowed,
        false,
        'Relative path with no ".." must not escape through a linked directory'
      );
      assert.strictEqual(
        getPathPolicyDecision('plain.txt', 'read').allowed,
        true,
        'Relative path with no ".." still permits a genuine file'
      );
    } finally {
      process.chdir(previousCwd);
    }

    // The same shape, but the traversal lands back somewhere legitimate.
    assert.strictEqual(
      getPathPolicyDecision(rawAt('safe', 'inner-link', '..', 'plain.txt'), 'read').allowed,
      true,
      '".." after a non-escaping symlink resolves within the allow root'
    );

    // A link that stays inside the allow root keeps working.
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'inner-link', 'real.txt'), 'read').allowed,
      true,
      'Symlink resolving to another location inside the allow root stays permitted'
    );
    // The allow root itself may be reached through a symlink; the canonical
    // target is inside the canonical root, so it is permitted.
    assert.strictEqual(
      getPathPolicyDecision(at('linked-root', 'plain.txt'), 'read').allowed,
      true,
      'Symlinked allow root resolves to the same canonical root'
    );
    // And a configured root that is itself a symlink still constrains.
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = at('linked-root');
    assert.strictEqual(getPathPolicyDecision(at('safe', 'plain.txt'), 'read').allowed, true, 'Symlinked allow root is canonicalized before comparison');
    assert.strictEqual(getPathPolicyDecision(at('outside', 'secret.txt'), 'read').allowed, false, 'Symlinked allow root still excludes outside paths');
    console.log('✓ Passed\n');

    console.log('Test 14: symlinks cannot bypass a deny root');
    resetPathEnv();
    process.env.SIDEKICK_DENIED_PATHS = denyRoot;
    // A lexical path outside the deny root that resolves into it.
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'deny-file'), 'read').allowed,
      false,
      'Symlink alias to a denied file must be denied'
    );
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'deny-dir', 'sub', 'nested.txt'), 'read').allowed,
      false,
      'Nested child of a symlinked denied directory must be denied'
    );
    // Deny is not weakened by canonicalization: a link inside the deny root
    // that points elsewhere is still refused, as it was lexically.
    assert.strictEqual(
      getPathPolicyDecision(at('secrets', 'escape'), 'read').allowed,
      false,
      'Symlink sitting inside a deny root stays denied even though it points outside'
    );
    // ".." after a symlink must not walk into a deny root unnoticed.
    assert.strictEqual(
      getPathPolicyDecision(rawAt('safe', 'deny-dir', '..', 'secrets', 'top.txt'), 'read').allowed,
      false,
      '".." after a symlink must not dodge a deny root'
    );
    // A deny root reached through a symlink must constrain just as well as a
    // real one; canonicalizing entries is what makes that hold.
    resetPathEnv();
    process.env.SIDEKICK_DENIED_PATHS = at('safe', 'deny-dir');
    assert.strictEqual(
      getPathPolicyDecision(at('secrets', 'top.txt'), 'read').allowed,
      false,
      'A symlinked deny root still denies its canonical contents'
    );
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'plain.txt'), 'read').allowed,
      true,
      'A symlinked deny root does not over-block'
    );

    // Probing inside a deny root must yield one uniform answer. If a dangling
    // link there reported its own reason, the deny root would become a
    // filesystem oracle for exactly the region the caller may not look at, and
    // the denial would lose the matched root that makes it auditable.
    resetPathEnv();
    process.env.SIDEKICK_DENIED_PATHS = denyRoot;
    for (const probe of ['top.txt', 'absent.txt', 'dangling-inside']) {
      const decision = getPathPolicyDecision(at('secrets', probe), 'read');
      assert.strictEqual(decision.allowed, false, `Deny root member ${probe} is denied`);
      assert.strictEqual(decision.reason, 'path denied by policy', `Deny root member ${probe} gives the ordinary reason`);
      assert.strictEqual(decision.matched, denyRoot, `Deny root member ${probe} records the matched root`);
    }

    // Deny still wins over an allow root that contains the alias.
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = safeRoot;
    process.env.SIDEKICK_DENIED_PATHS = denyRoot;
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'deny-file'), 'read').allowed,
      false,
      'A symlink inside the allow root must not reach a deny root elsewhere'
    );
    assert.strictEqual(getPathPolicyDecision(at('safe', 'plain.txt'), 'read').allowed, true, 'Deny must not over-block the rest of the allow root');
    console.log('✓ Passed\n');

    console.log('Test 15: nonexistent targets resolve through their existing ancestor');
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = safeRoot;
    // Normal new file under a real parent.
    assert.strictEqual(getPathPolicyDecision(at('safe', 'new.txt'), 'write').allowed, true, 'New file under the allow root is permitted');
    // Several missing components below a safe canonical parent.
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'a', 'b', 'c.txt'), 'write').allowed,
      true,
      'Several nonexistent descendants below a safe parent are permitted'
    );
    // Nearest existing ancestor is outside the allow root.
    assert.strictEqual(getPathPolicyDecision(at('outside', 'new.txt'), 'write').allowed, false, 'New file outside the allow root is denied');
    // The escape is in the existing prefix, below which nothing exists yet.
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'escape-dir', 'new-dir', 'new.txt'), 'write').allowed,
      false,
      'Nonexistent target below an escaping symlink must be denied'
    );
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'hop1', 'new.txt'), 'write').allowed,
      false,
      'Nonexistent target below a multi-hop escape must be denied'
    );
    // Validation must not create anything.
    assert.strictEqual(fs.existsSync(at('safe', 'a')), false, 'Policy evaluation must not create directories');
    assert.strictEqual(fs.existsSync(at('safe', 'new.txt')), false, 'Policy evaluation must not create files');
    // A nonexistent target that would land under a deny root.
    resetPathEnv();
    process.env.SIDEKICK_DENIED_PATHS = denyRoot;
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'deny-dir', 'new.txt'), 'write').allowed,
      false,
      'Nonexistent target resolving beneath a deny root must be denied'
    );
    console.log('✓ Passed\n');

    console.log('Test 16: broken symlinks fail closed');
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = safeRoot;
    // existsSync reports false for a dangling link exactly as it does for an
    // absent file; the policy must not confuse the two.
    assert.strictEqual(fs.existsSync(at('safe', 'broken')), false, 'Fixture must look absent to existsSync');
    assert.strictEqual(fs.lstatSync(at('safe', 'broken')).isSymbolicLink(), true, 'Fixture must be a symlink');

    const brokenDecision = getPathPolicyDecision(at('safe', 'broken'), 'read');
    assert.strictEqual(brokenDecision.allowed, false, 'A broken symlink must be denied, not treated as a new file');
    assert.strictEqual(brokenDecision.reason, 'path contains an unresolvable symlink', 'Broken links get a controlled reason');
    // A broken link as an intermediate component.
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'broken-dir', 'child.txt'), 'write').allowed,
      false,
      'A broken symlink in a parent component must be denied'
    );
    // Outside every configured root, a resolution failure must be indis-
    // tinguishable from an ordinary denial, or the reason string becomes an
    // existence-and-permission oracle for arbitrary paths.
    assert.strictEqual(
      getPathPolicyDecision(at('outside', 'nothing-here.txt'), 'read').reason,
      'path not in allowed paths',
      'Absent path outside the allow root gets the ordinary reason'
    );
    assert.strictEqual(
      getPathPolicyDecision(at('outside', 'stray-broken'), 'read').reason,
      'path not in allowed paths',
      'A dangling link outside the allow root must not be distinguishable from an absent one'
    );

    // And it is a controlled policy result, not a raw filesystem exception.
    const brokenBlocked = enforcePathPolicy(at('safe', 'broken'), 'read');
    assert.ok(brokenBlocked && brokenBlocked.isError === true, 'Broken link denial uses the standard error shape');
    assert.ok(
      brokenBlocked.content[0].text.startsWith('Path blocked by policy:'),
      'Broken link denial keeps the standard message prefix'
    );
    assert.ok(
      brokenBlocked.content[0].text.endsWith('path contains an unresolvable symlink.'),
      'Broken link denial explains itself'
    );
    console.log('✓ Passed\n');

    console.log('Test 17: policy roots and operations');
    // An unresolvable configured root fails closed rather than being skipped.
    resetPathEnv();
    process.env.SIDEKICK_DENIED_PATHS = at('safe', 'broken');
    const badRoot = getPathPolicyDecision(at('safe', 'plain.txt'), 'read');
    assert.strictEqual(badRoot.allowed, false, 'An unresolvable deny root must not be silently dropped');
    assert.strictEqual(badRoot.reason, 'policy configuration could not be resolved', 'Configuration faults get a controlled reason');
    assert.ok(
      !badRoot.reason.includes(LINK_ROOT),
      'A configuration fault must not echo the configured root back to the caller'
    );
    // The lockout is total and deliberate: an unrelated path is denied too,
    // because dropping a broken root could widen access.
    assert.strictEqual(
      getPathPolicyDecision(at('outside', 'secret.txt'), 'read').allowed,
      false,
      'An unresolvable root denies unrelated paths as well'
    );

    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = at('safe', 'broken');
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'plain.txt'), 'read').allowed,
      false,
      'An unresolvable allow root fails closed'
    );
    // A configured root that merely does not exist keeps its lexical behavior.
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = at('safe', 'not-created-yet');
    assert.strictEqual(
      getPathPolicyDecision(at('safe', 'not-created-yet', 'f.txt'), 'write').allowed,
      true,
      'An absent allow root still matches its own descendants'
    );

    // Operation labels do not select different roots in this policy, and the
    // escape is blocked identically whichever label is used.
    resetPathEnv();
    process.env.SIDEKICK_ALLOWED_PATHS = safeRoot;
    for (const operation of ['read', 'write', 'delete', 'security_scan', 'access']) {
      assert.strictEqual(
        getPathPolicyDecision(at('safe', 'escape-file'), operation).allowed,
        false,
        `Symlink escape is denied for operation "${operation}"`
      );
      assert.strictEqual(
        getPathPolicyDecision(at('safe', 'plain.txt'), operation).allowed,
        true,
        `Allowed path stays permitted for operation "${operation}"`
      );
    }
    // Ordinary lexical denials keep their existing wording.
    assert.strictEqual(getPathPolicyDecision(at('outside', 'secret.txt'), 'read').reason, 'path not in allowed paths');
    // A symlink escape is an ordinary allow-list miss, not a special error.
    assert.strictEqual(getPathPolicyDecision(at('safe', 'escape-file'), 'read').reason, 'path not in allowed paths');
    console.log('✓ Passed\n');

    console.log('Test 18: symlink escapes are blocked through the tool handlers');
    resetPathEnv();
    toolContext.setExecutionSource('mcp');
    process.env.SIDEKICK_ALLOWED_PATHS = safeRoot;

    // Read caller: the handler must refuse before touching the filesystem.
    const linkRead = await tools.TOOLS.read({ path: at('safe', 'escape-file') });
    assert.ok(linkRead.isError, 'read through an escaping symlink must be blocked');
    assert.ok(linkRead.content[0].text.includes('Path blocked by policy'), 'read surfaces the shared policy message');
    assert.ok(!linkRead.content[0].text.includes('outside secret'), 'Blocked read must not leak the target contents');

    const safeRead = await tools.TOOLS.read({ path: at('safe', 'plain.txt') });
    assert.ok(!safeRead.isError, 'Permitted read still succeeds');

    // Write caller: the escaping link must not be followed.
    const linkWrite = await tools.TOOLS.write({ path: at('safe', 'escape-file'), content: 'clobbered' });
    assert.ok(linkWrite.isError, 'write through an escaping symlink must be blocked');
    assert.strictEqual(
      fs.readFileSync(at('outside', 'secret.txt'), 'utf-8'),
      'outside secret',
      'Blocked write must not reach the symlink target'
    );

    const safeWrite = await tools.TOOLS.write({ path: at('safe', 'written.txt'), content: 'ok' });
    assert.ok(!safeWrite.isError, 'Permitted write still succeeds');
    assert.strictEqual(fs.readFileSync(at('safe', 'written.txt'), 'utf-8'), 'ok', 'Permitted write lands');

    // A broken link surfaces as a policy error, not an unhandled exception.
    const brokenRead = await tools.TOOLS.read({ path: at('safe', 'broken') });
    assert.ok(brokenRead.isError, 'read of a broken symlink is blocked');
    assert.ok(brokenRead.content[0].text.includes('Path blocked by policy'), 'Broken link keeps the shared policy message');
    console.log('✓ Passed\n');

    resetPathEnv();
    toolContext.setExecutionSource('mcp');
    console.log('All path policy tests passed.');
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    cleanupLinkRoot();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error(error.stack);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    cleanupLinkRoot();
    process.exit(1);
  }
})();
