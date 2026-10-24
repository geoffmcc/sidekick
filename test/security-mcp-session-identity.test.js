"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionManager } = require("../src/mcp/session-manager");
const { registerLegacySseRoutes } = require("../src/mcp/legacy-sse");
const { registerStreamableHttpRoutes } = require("../src/mcp/streamable-http");
const { SSEServerTransport } = require("@modelcontextprotocol/server-legacy/sse");

function createApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("MCP session identity rejects a different principal without rebinding the session", async t => {
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {} });
  t.after(() => manager.dispose());
  const original = { principal_id: "prn_owner", principal_type: "human", scopes: ["tools.execute"] };
  const authState = { current: original };
  const transport = {};
  manager.registerSession("owned-session", {}, transport, { authIdentity: original, authState });

  const result = await manager.getTransportForRequest("owned-session", {
    authIdentity: { principal_id: "prn_other", principal_type: "service", scopes: ["tools.execute"] },
  });
  assert.equal(result.identityMismatch, true);
  assert.equal(result.transport, null);
  assert.equal(authState.current, original);
});

test("default MCP session IDs use 192 bits of cryptographic randomness", async t => {
  const manager = createSessionManager({
    createMcpServer: () => ({ connect: async () => {}, close: async () => {} }),
    logDebug() {},
  });
  t.after(() => manager.dispose());

  const first = await manager.getTransportForRequest(null, { authIdentity: { principal_id: "prn_test" } });
  const second = await manager.getTransportForRequest(null, { authIdentity: { principal_id: "prn_test" } });
  assert.match(first.newSessionId, /^sess-[A-Za-z0-9_-]{32}$/);
  assert.match(second.newSessionId, /^sess-[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first.newSessionId, second.newSessionId);
});

test("MCP session accepts refreshed credentials only for its established principal", async t => {
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {} });
  t.after(() => manager.dispose());
  const original = { principal_id: "prn_service", principal_type: "service", scopes: ["tools.execute", "packs.manage"] };
  const refreshed = { principal_id: "prn_service", principal_type: "service", scopes: ["tools.execute"] };
  const authState = { current: original };
  const transport = {};
  manager.registerSession("owned-session", {}, transport, { authIdentity: original, authState });

  const result = await manager.getTransportForRequest("owned-session", { authIdentity: refreshed });
  assert.equal(result.transport, transport);
  assert.equal(result.identityMismatch, undefined);
  assert.equal(authState.current, refreshed, "the current same-principal credential scopes take effect");
});

test("MCP streamable HTTP returns 403 for another principal's session", async t => {
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {} });
  t.after(() => manager.dispose());
  manager.registerSession("owned-session", {}, {}, { authIdentity: { principal_id: "prn_owner" } });
  const app = createApp();
  registerStreamableHttpRoutes({ app, sessionManager: manager, createMcpServer: () => ({}), logDebug() {} });
  const res = createResponse();

  await app.routes.get("GET /mcp")({
    headers: { "mcp-session-id": "owned-session" },
    authIdentity: { principal_id: "prn_other" },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "session_identity_mismatch");
});

test("MCP transport failures hide exception details from clients and routine logs", async t => {
  const secretDiagnostic = "synthetic-secret /srv/sidekick/private/config.json";
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {} });
  t.after(() => manager.dispose());
  const transport = { handleRequest: async () => { throw new Error(secretDiagnostic); } };
  manager.registerSession("failing-session", {}, transport, { authIdentity: { principal_id: "prn_service" } });
  const app = createApp();
  const events = [];
  registerStreamableHttpRoutes({
    app,
    sessionManager: manager,
    createMcpServer: () => ({}),
    logDebug: (event, details) => events.push({ event, details }),
  });

  for (const method of ["GET", "DELETE", "POST"]) {
    const request = {
      headers: { "mcp-session-id": "failing-session", "content-type": "application/json" },
      authIdentity: { principal_id: "prn_service" },
    };
    if (method === "POST") {
      request.body = {
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      };
    }
    const res = createResponse();
    await app.routes.get(`${method} /mcp`)(request, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "MCP request failed" });
    assert.doesNotMatch(JSON.stringify(res.body), /synthetic-secret|private/);
  }

  assert.equal(events.length, 3);
  assert.ok(events.every(({ details }) => details.error === "internal_error"));
  assert.doesNotMatch(JSON.stringify(events), /synthetic-secret|private|stack/);
});

test("legacy SSE message posts cannot rebind another principal's session", async t => {
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {} });
  t.after(() => manager.dispose());
  const original = { principal_id: "prn_owner" };
  const authState = { current: original };
  manager.registerSession("owned-session", {}, {}, { authIdentity: original, authState });
  const app = createApp();
  registerLegacySseRoutes({ app, sessionManager: manager, createMcpServer: () => ({}) });
  const res = createResponse();

  await app.routes.get("POST /messages")({
    query: { sessionId: "owned-session" },
    authIdentity: { principal_id: "prn_other" },
    body: {},
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "session_identity_mismatch");
  assert.equal(authState.current, original);
});

test("legacy-key MCP sessions remain bound to the same identityless authentication method", async t => {
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {} });
  t.after(() => manager.dispose());
  const legacy = { authentication_method: "legacy_api_key", scopes: ["legacy"] };
  manager.registerSession("legacy-session", {}, {}, { authIdentity: legacy });

  const sameLegacy = await manager.getTransportForRequest("legacy-session", {
    authIdentity: { authentication_method: "legacy_api_key", scopes: ["legacy"] },
  });
  const scopedPrincipal = await manager.getTransportForRequest("legacy-session", {
    authIdentity: { principal_id: "prn_service", authentication_method: "scoped_credential", scopes: ["tools.execute"] },
  });
  assert.ok(sameLegacy.transport);
  assert.equal(scopedPrincipal.identityMismatch, true);
});

test("MCP session cleanup logs do not expose close exception details", async () => {
  const events = [];
  const manager = createSessionManager({
    createMcpServer: () => ({}),
    logDebug: (event, details) => events.push({ event, details }),
  });
  const secretDiagnostic = "synthetic-secret /srv/sidekick/private/config.json";
  manager.registerSession("cleanup-session", {}, {
    async close() { throw new Error(secretDiagnostic); },
  }, { authIdentity: { principal_id: "prn_service" } });
  await manager.dispose();

  const failures = events.filter(event => event.event === "SESSION_CLOSE_ERROR");
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].details, { sessionId: "cleanup-session", error: "internal_error" });
  assert.doesNotMatch(JSON.stringify(events), /synthetic-secret|private|stack/);
});

test("MCP session capacity limits individual identities and the whole server", async t => {
  const perIdentity = createSessionManager({ createMcpServer: () => ({}), logDebug() {}, maxSessions: 2, maxSessionsPerIdentity: 1 });
  t.after(() => perIdentity.dispose());
  perIdentity.registerSession("first", {}, {}, { authIdentity: { principal_id: "prn_a" } });
  const repeated = await perIdentity.getTransportForRequest(null, { authIdentity: { principal_id: "prn_a" } });
  assert.equal(repeated.capacityExceeded, true);
  assert.equal(repeated.capacityScope, "identity");
  assert.equal(repeated.capacityLimit, 1);

  const global = createSessionManager({ createMcpServer: () => ({}), logDebug() {}, maxSessions: 1, maxSessionsPerIdentity: 2 });
  t.after(() => global.dispose());
  global.registerSession("first", {}, {}, { authIdentity: { principal_id: "prn_a" } });
  const other = await global.getTransportForRequest(null, { authIdentity: { principal_id: "prn_b" } });
  assert.equal(other.capacityExceeded, true);
  assert.equal(other.capacityScope, "global");
  assert.equal(other.capacityLimit, 1);
});

test("legacy SSE refuses sessions above the per-identity cap before creating a server", async t => {
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {}, maxSessions: 2, maxSessionsPerIdentity: 1 });
  t.after(() => manager.dispose());
  manager.registerSession("first", {}, {}, { authIdentity: { principal_id: "prn_a" } });
  const app = createApp();
  let serverCreated = false;
  registerLegacySseRoutes({ app, sessionManager: manager, createMcpServer: () => { serverCreated = true; return {}; } });
  const res = createResponse();

  await app.routes.get("GET /sse")({ authIdentity: { principal_id: "prn_a" }, headers: {} }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, "session_capacity_exceeded");
  assert.equal(serverCreated, false);
});

test("legacy SSE route failures hide exception details from clients and routine logs", async t => {
  const secretDiagnostic = "synthetic-secret /srv/sidekick/private/config.json";
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {} });
  t.after(() => manager.dispose());
  const app = createApp();
  registerLegacySseRoutes({
    app,
    sessionManager: manager,
    createMcpServer: () => { throw new Error(secretDiagnostic); },
  });

  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const res = createResponse();
    await app.routes.get("GET /sse")({ headers: {}, authIdentity: { principal_id: "prn_service" } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "MCP request failed" });
  } finally {
    console.error = originalError;
  }
  assert.doesNotMatch(logs.join(" "), /synthetic-secret|private/);
});

test("legacy SSE message failures hide exception details from clients and routine logs", async t => {
  const secretDiagnostic = "synthetic-secret /srv/sidekick/private/config.json";
  const manager = createSessionManager({ createMcpServer: () => ({}), logDebug() {} });
  t.after(() => manager.dispose());
  const transport = Object.create(SSEServerTransport.prototype);
  transport.handlePostMessage = async () => { throw new Error(secretDiagnostic); };
  const authIdentity = { principal_id: "prn_service" };
  manager.registerSession("failing-sse-session", {}, transport, { authIdentity });
  const app = createApp();
  registerLegacySseRoutes({ app, sessionManager: manager, createMcpServer: () => ({}) });

  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const res = createResponse();
    await app.routes.get("POST /messages")({
      query: { sessionId: "failing-sse-session" },
      body: {},
      authIdentity,
    }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "MCP request failed" });
  } finally {
    console.error = originalError;
  }
  assert.doesNotMatch(logs.join(" "), /synthetic-secret|private/);
});
