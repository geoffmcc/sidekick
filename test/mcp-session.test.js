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
  'Stale POST requests should be able to recover on a replacement session'
);

assert.match(
  indexJs,
  /const activeSessionId = newSessionId \|\| sessionId;[\s\S]*?if \(activeSession && !activeSession\.initialized && req\.body\?\.method !== "initialize"\) \{\s*return sendInvalidSession\(res, \{[\s\S]*?Send initialize before retrying this request\./,
  'Non-initialize POST requests to uninitialized sessions should explicitly ask clients to initialize instead of hitting the SDK transport'
);

assert.doesNotMatch(
  indexJs,
  /activeSession && !activeSession\.initialized[\s\S]*?Server not initialized/,
  'Uninitialized-session POST recovery should not return the generic uninitialized-server error'
);

assert.match(
  indexJs,
  /replacedStaleSession && newSessionId \? \{ \.\.\.wh, "mcp-session-id": newSessionId \} : wh/,
  'Replacement-session initialize requests should be forwarded with the new session header'
);

assert.match(
  indexJs,
  /if \(replacedStaleSession && newSessionId\) \{\s*res\.setHeader\("mcp-session-id", newSessionId\);\s*\}/,
  'Recovered stale POST responses should tell clients which replacement session was used'
);

console.log('MCP session recovery checks passed\n');
