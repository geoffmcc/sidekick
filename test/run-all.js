#!/usr/bin/env node

/**
 * Sidekick Test Runner
 * 
 * Runs all test suites in priority order with fail-fast on security issues.
 * Security tests must pass before other tests are run.
 * 
 * Usage: node test/run-all.js
 */

const { execSync } = require('child_process');
const path = require('path');

// Test suites in priority order
const testSuites = [
  {
    name: 'security.test.js',
    path: 'test/security.test.js',
    critical: true,
    description: 'Security tests (redaction, auth, dangerous commands)'
  },
  {
    name: 'kv-migration.test.js',
    path: 'test/kv-migration.test.js',
    critical: false,
    description: 'KV store migration tests'
  },
  {
    name: 'tools.test.js',
    path: 'test/tools.test.js',
    critical: false,
    description: 'Tools module tests'
  },
  {
    name: 'dashboard-api.test.js',
    path: 'test/dashboard-api.test.js',
    critical: false,
    description: 'Dashboard API tests'
  },
  {
    name: 'integration.test.js',
    path: 'test/integration.test.js',
    critical: false,
    description: 'Integration tests'
  }
];

// Future test suites (not yet implemented)
const futureSuites = [
  {
    name: 'error-handling.test.js',
    path: 'test/error-handling.test.js',
    critical: false,
    description: 'Error handling tests'
  },
  {
    name: 'mcp-protocol.test.js',
    path: 'test/mcp-protocol.test.js',
    critical: false,
    description: 'MCP protocol compliance tests'
  },
  {
    name: 'agent.test.js',
    path: 'test/agent.test.js',
    critical: false,
    description: 'Agent bridge tests'
  },
  {
    name: 'dashboard-extended.test.js',
    path: 'test/dashboard-extended.test.js',
    critical: false,
    description: 'Extended dashboard API tests'
  },
  {
    name: 'performance.test.js',
    path: 'test/performance.test.js',
    critical: false,
    description: 'Performance and load tests'
  },
  {
    name: 'backward-compat.test.js',
    path: 'test/backward-compat.test.js',
    critical: false,
    description: 'Backward compatibility tests'
  }
];

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failedSuites = [];

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║           Sidekick Test Runner                            ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log('');

// Run each test suite
for (const suite of testSuites) {
  console.log('');
  console.log('═'.repeat(60));
  console.log(`Running: ${suite.name}`);
  console.log(`Description: ${suite.description}`);
  if (suite.critical) {
    console.log('⚠️  CRITICAL: This suite must pass before continuing');
  }
  console.log('═'.repeat(60));
  console.log('');

  try {
    // Run the test suite
    execSync(`node ${suite.path}`, { 
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    
    passedTests++;
    console.log('');
    console.log(`✅ ${suite.name} PASSED`);
    
  } catch (error) {
    failedTests++;
    failedSuites.push(suite.name);
    console.log('');
    console.log(`❌ ${suite.name} FAILED`);
    
    // If this is a critical suite, fail immediately
    if (suite.critical) {
      console.log('');
      console.log('🚨 CRITICAL FAILURE: Security tests must pass before continuing');
      console.log('');
      printSummary();
      process.exit(1);
    }
  }
  
  totalTests++;
}

// Print summary
printSummary();

// Print future test suites
console.log('');
console.log('═'.repeat(60));
console.log('📋 Future Test Suites (Not Yet Implemented)');
console.log('═'.repeat(60));
futureSuites.forEach(suite => {
  console.log(`  • ${suite.name.padEnd(30)} - ${suite.description}`);
});
console.log('');

// Exit with appropriate code
process.exit(failedTests > 0 ? 1 : 0);

function printSummary() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║                    Test Summary                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Total Suites:  ${totalTests}`);
  console.log(`Passed:        ${passedTests} ✅`);
  console.log(`Failed:        ${failedTests} ❌`);
  console.log('');
  
  if (failedSuites.length > 0) {
    console.log('Failed Suites:');
    failedSuites.forEach(suite => {
      console.log(`  ❌ ${suite}`);
    });
    console.log('');
  }
  
  if (failedTests === 0) {
    console.log('🎉 All tests passed!');
  } else {
    console.log('⚠️  Some tests failed. Please review the output above.');
  }
  console.log('');
}
