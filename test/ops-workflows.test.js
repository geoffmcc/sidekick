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
  /ops:\s*"critical"/,
  'ops should be critical risk because it can deploy and restart services'
);

assert.match(
  toolsJs,
  /async function sidekick_mission\s*\(/,
  'sidekick_mission should define a Mission Control workflow tool'
);

assert.match(
  toolsJs,
  /mission:\s*"critical"/,
  'mission should be critical risk because it can execute operational workflows'
);

assert.match(
  toolsJs,
  /'ops':\s*'Workflow'/,
  'ops should be categorized as a workflow tool'
);

assert.match(
  toolsJs,
  /'mission':\s*'Workflow'/,
  'mission should be categorized as a workflow tool'
);

assert.match(
  toolsJs,
  /name:\s*"ops"[\s\S]*verify_deployed_commit\|restart_and_smoke_test\|deploy_current_main\|incident_snapshot/,
  'ops metadata should list the packaged workflow actions'
);

assert.match(
  toolsJs,
  /name:\s*"mission"[\s\S]*profiles\|route\|preflight\|execute/,
  'mission metadata should list Mission Control actions'
);

assert.match(
  toolsJs,
  /scheduleMcpRestart\s*\(/,
  'sidekick_ops should schedule MCP self-restarts instead of blocking the response'
);

assert.match(
  toolsJs,
  /function filterGitStatus\s*\(/,
  'sidekick_ops should ignore the known package-lock.json noise in deploy checks'
);

assert.match(
  toolsJs,
  /policy:\s*\{\s*tool:\s*"tools",\s*args:\s*\{\s*action:\s*"policy"/,
  'mission should route policy inspection through tools action=policy'
);

assert.match(
  toolsJs,
  /--max-time", "5", "-fsS"/,
  'sidekick_ops should bound the MCP health probe'
);

assert.match(
  toolsJs,
  /await runOpsCommandAsync\s*\(/,
  'sidekick_ops should probe its own MCP health endpoint asynchronously to avoid blocking the event loop'
);

assert.match(
  indexJs,
  /ops:\s*z\.object\(\{[\s\S]*verify_deployed_commit[\s\S]*restart_and_smoke_test[\s\S]*deploy_current_main[\s\S]*incident_snapshot/,
  'MCP schema should expose ops actions'
);

assert.match(
  indexJs,
  /mission:\s*z\.object\(\{[\s\S]*profiles[\s\S]*route[\s\S]*preflight[\s\S]*execute/,
  'MCP schema should expose mission actions'
);

console.log('Operations workflow checks passed\n');
