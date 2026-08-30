const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const streamableHttpJs = fs.readFileSync(path.join(root, 'src', 'mcp', 'streamable-http.js'), 'utf8');
const sessionManagerJs = fs.readFileSync(path.join(root, 'src', 'mcp', 'session-manager.js'), 'utf8');
const indexJs = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
const { createSessionManager } = require(path.join(root, 'src', 'mcp', 'session-manager'));

console.log('Running MCP session recovery tests...\n');

assert.match(
  streamableHttpJs,
  /function sendInvalidSession\s*\(/,
  'MCP server should centralize invalid-session responses'
);

assert.match(
  sessionManagerJs,
  /return \{ transport: null, isNew: false, newSessionId: null, staleRedirect: true \}/,
  'Unknown MCP session IDs must not create replacement sessions'
);

assert.match(indexJs, /httpServer\.close\(/, 'production shutdown should close the HTTP listener');
assert.match(indexJs, /await sessionManager\.dispose\(\)/, 'production shutdown should dispose MCP sessions');
assert.match(indexJs, /browserSubsystem\.shutdown\(\)/, 'production shutdown should close browser sessions');
assert.match(indexJs, /compute\.stopReconciliation\(\)/, 'production shutdown should stop compute timers');
assert.match(indexJs, /eventDrainer\.stopDrainer\(\)/, 'production shutdown should stop event delivery timers');
assert.match(indexJs, /dbStore\.closeDatabase\(\)/, 'production shutdown should close the database');

(async () => {
  let currentTime = 0;
  let created = 0;
  let transportClosed = 0;
  let serverClosed = 0;
  const manager = createSessionManager({
    now: () => currentTime,
    createMcpServer: () => { created += 1; return { close: async () => { serverClosed += 1; } }; },
    logDebug: () => {},
  });
  const transport = { close: async () => { transportClosed += 1; } };
  manager.registerSession('idle', { close: async () => { serverClosed += 1; } }, transport);
  currentTime = 3600001;
  await manager.cleanupIdleSessions();
  assert.strictEqual(manager.hasSession('idle'), false, 'idle sessions should be evicted');
  assert.strictEqual(transportClosed, 1, 'evicted transports should be closed');
  assert.strictEqual(serverClosed, 1, 'evicted servers should be closed');

  const unknown = await manager.getTransportForRequest('not-issued-by-server');
  assert.strictEqual(unknown.transport, null, 'unknown sessions should not get a transport');
  assert.strictEqual(unknown.staleRedirect, true, 'unknown sessions should use invalid-session handling');
  assert.strictEqual(unknown.newSessionId, null, 'unknown sessions should not receive a replacement ID');
  assert.strictEqual(created, 0, 'unknown sessions must not invoke server creation');
  await manager.dispose();
  console.log('MCP session lifecycle checks passed\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

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
