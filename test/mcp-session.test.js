const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexJs = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');

console.log('Running MCP session recovery tests...\n');

assert.match(
  indexJs,
  /function sendInvalidSession\s*\(/,
  'MCP server should centralize invalid-session responses'
);

assert.match(
  indexJs,
  /res\.status\(404\)/,
  'Invalid MCP sessions should return HTTP 404 so clients can reconnect'
);

assert.match(
  indexJs,
  /res\.setHeader\("Connection", "close"\)/,
  'Invalid MCP sessions should close stale HTTP connections'
);

assert.match(
  indexJs,
  /allowStalePost:\s*true/,
  'Stale POST requests should be transparently forwarded on a replacement session'
);

assert.match(
  indexJs,
  /replacedStaleSession && newSessionId \? \{ \.\.\.wh, "mcp-session-id": newSessionId \} : wh/,
  'Replacement-session POST requests should be forwarded with the new session header'
);

assert.match(
  indexJs,
  /if \(replacedStaleSession && newSessionId\) \{\s*res\.setHeader\("mcp-session-id", newSessionId\);\s*\}/,
  'Recovered stale POST responses should tell clients which replacement session was used'
);

console.log('MCP session recovery checks passed\n');
