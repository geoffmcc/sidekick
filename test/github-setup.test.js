const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml');
const pkgPath = path.join(root, 'package.json');
const gitignorePath = path.join(root, '.gitignore');

console.log('Running GitHub setup tests...\n');

assert.ok(fs.existsSync(workflowPath), 'Missing .github/workflows/ci.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
assert.match(workflow, /on:\s*\n\s*push:/, 'Workflow should run on push');
assert.match(workflow, /pull_request:/, 'Workflow should run on pull requests');
assert.match(workflow, /permissions:\s*\{\}/, 'Workflow should default to no token permissions');
assert.match(workflow, /fast-gate:[\s\S]*?permissions:\s*\n\s+contents:\s+read/, 'Fast gate should request read-only repository contents');
assert.match(workflow, /actions\/checkout@[0-9a-f]{40}\s+# v5/, 'Workflow should pin checkout v5 to an immutable commit');
assert.match(workflow, /persist-credentials:\s*false/, 'Checkout must not persist the GitHub token');
assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}\s+# v5/, 'Workflow should pin setup-node v5 to an immutable commit');
assert.match(workflow, /node-version:\s*\[22\.x,\s*24\.x\]/, 'Workflow should test Node 22.x and 24.x');
assert.match(workflow, /node scripts\/run-tests\.js --domain=\$\{\{ matrix\.domain \}\}/, 'Workflow should run domain shards through the standard runner');
assert.match(workflow, /node scripts\/run-tests\.js --tier=compatibility/, 'Workflow should run the compatibility tier exactly once per Node version');
assert.doesNotMatch(workflow, /pull_request_target|secrets\./, 'Fork-safe CI must not use privileged PR triggers or secrets');
assert.ok(!/dashboard-password-from-local-test-data|ghp_|github_pat_|BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY/.test(workflow), 'Workflow must not contain obvious secrets');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
assert.ok(pkg.scripts, 'package.json should define scripts');
assert.match(pkg.scripts.test, /node test\/run-all\.js/, 'npm test should run the standard runner');
assert.strictEqual(pkg.scripts['test:ci'], 'node scripts/run-tests.js', 'CI script should persist the standard runner report');
assert.match(pkg.scripts['test:certification'], /node test\/run-all\.js/, 'certification script should use the standard runner');
for (const name of ['test:smoke', 'test:unit', 'test:contract', 'test:integration', 'test:security', 'test:coverage', 'test:mutation', 'test:flake', 'test:changed', 'test:all', 'test:live']) assert.ok(pkg.scripts[name], `missing testing workflow script ${name}`);
assert.ok(pkg.scripts['test:security'], 'package.json should expose test:security');
assert.ok(pkg.engines && pkg.engines.node, 'package.json should declare a Node engine');

const gitignore = fs.readFileSync(gitignorePath, 'utf8');
for (const ignored of ['node_modules/', '.env', 'data/*', '.opencode/', 'opencode.json']) {
  assert.ok(gitignore.includes(ignored), `.gitignore should include ${ignored}`);
}

console.log('✓ GitHub Actions workflow and npm scripts are configured\n');
