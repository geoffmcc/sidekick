"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionManager } = require("../src/mcp/session-manager");
const { registerLegacySseRoutes } = require("../src/mcp/legacy-sse");
const { registerStreamableHttpRoutes } = require("../src/mcp/streamable-http");

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
