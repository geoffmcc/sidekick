const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const streamableHttpJs = fs.readFileSync(path.join(root, 'src', 'mcp', 'streamable-http.js'), 'utf8');
const sessionManagerJs = fs.readFileSync(path.join(root, 'src', 'mcp', 'session-manager.js'), 'utf8');

console.log('Running MCP session recovery tests...\n');

assert.match(
  streamableHttpJs,
  /function sendInvalidSession\s*\(/,
  'MCP server should centralize invalid-session responses'
);

assert.match(
  streamableHttpJs,
  /res\.status\(404\)/,
  'Invalid MCP sessions should return HTTP 404 so clients can reconnect'
);

assert.match(
  streamableHttpJs,
  /res\.setHeader\("Connection", "close"\)/,
  'Invalid MCP sessions should close stale HTTP connections'
);

assert.match(
  streamableHttpJs,
  /allowStalePost:\s*true/,
  'Stale POST requests should be able to recover on a replacement session'
);

assert.match(
  streamableHttpJs,
  /const activeSessionId = newSessionId \|\| sessionId;[\s\S]*?activeSession && !activeSession\.initialized && req\.body\?\.method !== "initialize"[\s\S]*?MCP session is not initialized\. Send initialize before retrying this request\./,
  'Non-initialize POST requests to uninitialized sessions should explicitly ask clients to initialize instead of hitting the SDK transport'
);

assert.doesNotMatch(
  streamableHttpJs,
  /activeSession && !activeSession\.initialized[\s\S]*?Server not initialized/,
  'Uninitialized-session POST recovery should not return the generic uninitialized-server error'
);

assert.match(
  streamableHttpJs,
  /replacedStaleSession && newSessionId \? \{ \.\.\.wh, "mcp-session-id": newSessionId \} : wh/,
  'Replacement-session initialize requests should be forwarded with the new session header'
);

assert.match(
  streamableHttpJs,
  /if \(replacedStaleSession && newSessionId\) res\.setHeader\("mcp-session-id", newSessionId\);/,
  'Recovered stale POST responses should tell clients which replacement session was used'
);

console.log('MCP session recovery checks passed\n');
