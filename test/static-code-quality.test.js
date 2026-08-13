const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const excludedDirs = new Set(['.git', 'node_modules', 'data', '.opencode', 'spike-openvino-node', 'spike-openvino-python']);
const excludedFiles = new Set(['opencode.json', 'package-lock.json', 'security.test.js', 'github-setup.test.js', 'static-code-quality.test.js']);
const textExtensions = new Set(['.js', '.json', '.md', '.yml', '.yaml', '.sh', '.ps1', '.service', '.example', '.gitignore', '.gitattributes']);

console.log('Running static code quality tests...\n');

function walk(dir) {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...walk(full));
    else entries.push(full);
  }
  return entries;
}

function isTextFile(file) {
  if (excludedFiles.has(path.basename(file))) return false;
  const ext = path.extname(file);
  return textExtensions.has(ext);
}

const files = walk(root).filter(isTextFile);
assert.ok(files.length > 0, 'Expected text files to scan');

const forbidden = [
  { name: 'GitHub classic token', pattern: /ghp_[A-Za-z0-9_]{36}/ },
  { name: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{40,}/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'hardcoded dashboard password from local test data', pattern: /dashboard-password-from-local-test-data/i },
];

const violations = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(!content.includes('\r\n'), `${rel} should use LF line endings`);
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) violations.push(`${rel}: ${rule.name}`);
  }
}

assert.deepStrictEqual(violations, [], 'Secret/static violations found:\n' + violations.join('\n'));

// Scoped developer-path / private-workspace leak scan for the Security Research
// surface. The pack's whole reason to exist is a hard public/private boundary,
// so its committed code, tests and docs must use generic placeholders and never
// a real developer-machine path or a private research-workspace path. Scoped to
// this surface (rather than repo-wide) because existing suites legitimately
// embed sample absolute paths in assertions; the pack surface has no such
// excuse. The pack's own unit test is skipped here because it deliberately
// DEFINES these detection patterns.
const researchSurface = files.filter(file => {
  if (path.basename(file) === 'security-research-unit.test.js') return false;
  const rel = path.relative(root, file).split(path.sep).join('/');
  return rel.startsWith('packs/security-research/')
    || rel.startsWith('test/security-research')
    || /^docs\/security-research/.test(rel);
});
const developerPathRules = [
  { name: 'WSL mount path', pattern: /\/mnt\/[a-z]\// },
  { name: 'Windows user directory', pattern: /[A-Za-z]:\\Users\\/ },
  { name: 'developer home project/research directory', pattern: /\/home\/[a-z0-9_.-]+\/(?:Projects|Desktop|Documents|research|security-research)\b/ },
  { name: 'authorization header value', pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{8,}/i },
];
const researchViolations = [];
for (const file of researchSurface) {
  const rel = path.relative(root, file);
  const content = fs.readFileSync(file, 'utf8');
  for (const rule of developerPathRules) {
    if (rule.pattern.test(content)) researchViolations.push(`${rel}: ${rule.name}`);
  }
}
assert.deepStrictEqual(researchViolations, [], 'Security Research surface leaked a developer/private path:\n' + researchViolations.join('\n'));

const toolsFacadePath = path.join(root, 'src', 'tools.js');
const toolsLegacyPath = path.join(root, 'src', 'tools-legacy.js');
const shellFamilyPath = path.join(root, 'src', 'tools', 'families', 'shell.js');
const toolsFacade = fs.readFileSync(toolsFacadePath, 'utf8');
const toolsLegacy = fs.readFileSync(toolsLegacyPath, 'utf8');
const shellFamily = fs.readFileSync(shellFamilyPath, 'utf8');
assert.match(toolsFacade, /module\.exports\s*=\s*require\("\.\/tools\/index"\)/, 'tools.js should remain a compatibility facade to the authoritative tool layer');
assert.match(shellFamily, /function isDangerous\s*\(/, 'families/shell.js should define isDangerous (moved from tools-legacy in B-5)');
assert.match(toolsLegacy, /module\.exports\s*=\s*\{[\s\S]*isDangerous/, 'tools-legacy.js should re-export isDangerous for security tests during migration');

console.log(`✓ Scanned ${files.length} text files for basic CI safety checks\n`);
