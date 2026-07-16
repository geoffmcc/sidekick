const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const excludedDirs = new Set(['.git', 'node_modules', 'data', '.opencode']);
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

const toolsFacadePath = path.join(root, 'src', 'tools.js');
const toolsLegacyPath = path.join(root, 'src', 'tools-legacy.js');
const toolsFacade = fs.readFileSync(toolsFacadePath, 'utf8');
const toolsLegacy = fs.readFileSync(toolsLegacyPath, 'utf8');
assert.match(toolsFacade, /module\.exports\s*=\s*require\("\.\/tools-legacy"\)/, 'tools.js should remain a compatibility facade');
assert.match(toolsLegacy, /function isDangerous\s*\(/, 'tools-legacy.js should define isDangerous during migration');
assert.match(toolsLegacy, /module\.exports\s*=\s*\{[\s\S]*isDangerous/, 'tools-legacy.js should export isDangerous for security tests');

console.log(`✓ Scanned ${files.length} text files for basic CI safety checks\n`);
