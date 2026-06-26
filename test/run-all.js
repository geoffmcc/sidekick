#!/usr/bin/env node

/**
 * Sidekick Test Runner
 *
 * Runs suites in a GitHub Actions friendly order. Security/static checks run
 * first, missing optional suites are skipped, and failures produce a summary.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const suites = [
  { file: 'test/github-setup.test.js', critical: true, description: 'GitHub workflow and package script checks' },
  { file: 'test/static-code-quality.test.js', critical: true, description: 'Static safety checks' },
  { file: 'test/security.test.js', critical: true, description: 'Redaction and dangerous command checks' },
  { file: 'test/security-scan.test.js', critical: true, description: 'Read-only config and secret scan behavior' },
  { file: 'test/deploy-scripts.test.js', critical: false, description: 'Deploy script checks' },
  { file: 'test/mcp-session.test.js', critical: false, description: 'MCP stale session recovery behavior' },
  { file: 'test/ops-workflows.test.js', critical: false, description: 'Packaged operations workflow metadata' },
  { file: 'test/tools.test.js', critical: false, description: 'Core tool behavior' },
  { file: 'test/approval.test.js', critical: false, description: 'Approval queue behavior' },
  { file: 'test/new-tools.test.js', critical: false, description: 'Extended tool behavior' },
  { file: 'test/evolve.test.js', critical: false, description: 'Evolve tool and retention behavior' },
  { file: 'test/db-tools.test.js', critical: false, description: 'Database tools behavior' },
  { file: 'test/automatic-memory.test.js', critical: false, description: 'Automatic memory capture and recall' },
  { file: 'test/memory-lifecycle.test.js', critical: false, description: 'Memory lifecycle behavior' },
  { file: 'test/memory-deferred.test.js', critical: false, description: 'Deferred memory lifecycle behavior' },
  { file: 'test/memory-sync.test.js', critical: false, description: 'Memory sync behavior' },
  { file: 'test/integration.test.js', critical: false, description: 'Integration behavior' },
  { file: 'test/dashboard-api.test.js', critical: false, description: 'Dashboard API behavior' },
];

const requested = process.argv.slice(2);
const selected = requested.length
  ? suites.filter((suite) => requested.includes(path.basename(suite.file)) || requested.includes(suite.file))
  : suites;

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║                    Sidekick Tests                         ║');
console.log('╚═══════════════════════════════════════════════════════════╝');

for (const suite of selected) {
  const suitePath = path.join(root, suite.file);
  if (!fs.existsSync(suitePath)) {
    if (suite.optional) {
      skipped++;
      console.log(`\n↷ Skipping optional missing suite: ${suite.file}`);
      continue;
    }
    failed++;
    failures.push(`${suite.file} (missing)`);
    if (suite.critical) break;
    continue;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Running: ${suite.file}`);
  console.log(`Purpose: ${suite.description}`);
  if (suite.critical) console.log('Critical: yes');
  console.log('═'.repeat(60) + '\n');

  const result = spawnSync(process.execPath, [suite.file], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
  });

  if (result.status === 0) {
    passed++;
    console.log(`\n✅ ${suite.file} passed`);
  } else {
    failed++;
    failures.push(suite.file);
    console.log(`\n❌ ${suite.file} failed`);
    if (suite.critical) {
      console.log('\nStopping because a critical suite failed.');
      break;
    }
  }
}

console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║                       Summary                             ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log(`Passed:  ${passed}`);
console.log(`Failed:  ${failed}`);
console.log(`Skipped: ${skipped}`);

if (failures.length) {
  console.log('\nFailed suites:');
  for (const failure of failures) console.log(`  - ${failure}`);
}

process.exit(failed > 0 ? 1 : 0);
