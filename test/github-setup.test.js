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
assert.match(workflow, /actions\/checkout@v4/, 'Workflow should use checkout@v4');
assert.match(workflow, /actions\/setup-node@v4/, 'Workflow should use setup-node@v4');
assert.match(workflow, /npm run test:ci/, 'Workflow should run npm run test:ci');
assert.ok(!/dashboard-password-from-local-test-data|ghp_|github_pat_|BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY/.test(workflow), 'Workflow must not contain obvious secrets');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
assert.ok(pkg.scripts, 'package.json should define scripts');
assert.strictEqual(pkg.scripts.test, 'node test/run-all.js', 'npm test should run the main test runner');
assert.strictEqual(pkg.scripts['test:ci'], 'node test/run-all.js', 'npm run test:ci should run the main test runner');
assert.ok(pkg.scripts['test:security'], 'package.json should expose test:security');
assert.ok(pkg.engines && pkg.engines.node, 'package.json should declare a Node engine');

const gitignore = fs.readFileSync(gitignorePath, 'utf8');
for (const ignored of ['node_modules/', '.env', 'data/*', '.opencode/', 'opencode.json']) {
  assert.ok(gitignore.includes(ignored), `.gitignore should include ${ignored}`);
}

console.log('✓ GitHub Actions workflow and npm scripts are configured\n');
