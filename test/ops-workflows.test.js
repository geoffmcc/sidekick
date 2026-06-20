const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const toolsJs = fs.readFileSync(path.join(root, 'src', 'tools.js'), 'utf8');
const indexJs = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');

console.log('Running operations workflow tests...\n');

assert.match(
  toolsJs,
  /async function sidekick_ops\s*\(/,
  'sidekick_ops should define a packaged operations workflow tool'
);

assert.match(
  toolsJs,
  /sidekick_ops:\s*"critical"/,
  'sidekick_ops should be critical risk because it can deploy and restart services'
);

assert.match(
  toolsJs,
  /'sidekick_ops':\s*'Workflow'/,
  'sidekick_ops should be categorized as a workflow tool'
);

assert.match(
  toolsJs,
  /name:\s*"sidekick_ops"[\s\S]*verify_deployed_commit\|restart_and_smoke_test\|deploy_current_main\|incident_snapshot/,
  'sidekick_ops metadata should list the packaged workflow actions'
);

assert.match(
  toolsJs,
  /scheduleMcpRestart\s*\(/,
  'sidekick_ops should schedule MCP self-restarts instead of blocking the response'
);

assert.match(
  indexJs,
  /sidekick_ops:\s*z\.object\(\{[\s\S]*verify_deployed_commit[\s\S]*restart_and_smoke_test[\s\S]*deploy_current_main[\s\S]*incident_snapshot/,
  'MCP schema should expose sidekick_ops actions'
);

console.log('Operations workflow checks passed\n');
