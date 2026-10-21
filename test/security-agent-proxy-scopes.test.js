"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentProxyHeaders, createSqliteNonceConsumer, verifyAgentProxyRequest } = require("../src/security/agent-proxy-auth");
const { registerAgentProxyRoutes } = require("../src/dashboard/agent-proxy-routes");

const secret = "synthetic-agent-proxy-secret-for-scope-contract-tests";
const method = "POST";
const requestPath = "/api/agent/run";
const now = 1_800_000_000_000;

function verify(scopes) {
  const headers = createAgentProxyHeaders({ secret, method, path: requestPath, principalId: "principal-test", scopes, now, nonce: `nonce_${String(scopes)}_abcdefghijklmnop` });
  return { headers, identity: verifyAgentProxyRequest({ secret, method, path: requestPath, headers, now, usedNonces: new Map() }) };
}

test("signed Dashboard proxy preserves role-session null separately from explicit empty scopes", () => {
  const roleSession = verify(null);
  assert.equal(roleSession.headers["X-Sidekick-Principal-Scopes"], "null");
  assert.equal(roleSession.identity.scopes, null, "interactive Dashboard sessions retain role-based authorization semantics");

  const machineCredential = verify([]);
  assert.equal(machineCredential.headers["X-Sidekick-Principal-Scopes"], "[]");
  assert.deepEqual(machineCredential.identity.scopes, [], "an explicit empty machine credential remains deny-all");
});

test("signed proxy scope mode cannot be changed without invalidating the signature", () => {
  const roleSession = verify(null);
  const tamperedHeaders = { ...roleSession.headers, "X-Sidekick-Principal-Scopes": "[]" };
  assert.equal(verifyAgentProxyRequest({ secret, method, path: requestPath, headers: tamperedHeaders, now, usedNonces: new Map() }), null);
});

test("SQLite nonce consumption rejects replay across independent Agent process consumers", () => {
  const Database = require("better-sqlite3");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-proxy-nonce-replay-"));
  const file = path.join(directory, "shared.db");
  const firstDb = new Database(file);
  const secondDb = new Database(file);
  firstDb.exec("CREATE TABLE agent_proxy_nonces (nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL CHECK (expires_at > 0))");
  const firstProcessConsumer = createSqliteNonceConsumer(firstDb);
  const secondProcessConsumer = createSqliteNonceConsumer(secondDb);
  try {
    const headers = createAgentProxyHeaders({
      secret,
      method,
      path: requestPath,
      principalId: "principal-test",
      scopes: ["agent.tasks.read"],
      now,
      nonce: "cross_process_replay_nonce_1234567890",
    });
    assert.ok(verifyAgentProxyRequest({ secret, method, path: requestPath, headers, now, consumeNonce: firstProcessConsumer }));
    assert.equal(verifyAgentProxyRequest({ secret, method, path: requestPath, headers, now, consumeNonce: secondProcessConsumer }), null);
    assert.equal(firstDb.prepare("SELECT COUNT(*) AS count FROM agent_proxy_nonces").get().count, 1);
    const boundedConsumer = createSqliteNonceConsumer(secondDb, 1);
    assert.equal(boundedConsumer("nonce_capacity_blocked_1234567890", now + 120_000, now), false, "active nonce storage retains its fail-closed cap");
    assert.equal(boundedConsumer("nonce_after_expiry_1234567890", now + 240_000, now + 120_001), true, "expired replay records are pruned before accepting new work");
    const serviceHeaders = createAgentProxyHeaders({ secret, method, path: requestPath, service: "scheduler", now, nonce: "scheduler_cross_process_nonce_123456" });
    const serviceIdentity = verifyAgentProxyRequest({ secret, method, path: requestPath, headers: serviceHeaders, now, consumeNonce: firstProcessConsumer });
    assert.equal(serviceIdentity?.principal_id, null, "identityless scheduler requests also consume shared nonces");
    assert.equal(verifyAgentProxyRequest({ secret, method, path: requestPath, headers: serviceHeaders, now, consumeNonce: secondProcessConsumer }), null, "service identity assertions cannot be replayed across processes");
  } finally {
    firstDb.close();
    secondDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Agent proxy middleware uses the durable consumer rather than process-local replay state", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "agent.js"), "utf8");
  assert.match(source, /createSqliteNonceConsumer\(dbStore\.getDb\(\)\)/);
  assert.match(source, /consumeNonce:\s*consumeAgentProxyNonce/);
  assert.doesNotMatch(source, /agentProxyNonces/);
});

test("Dashboard Agent relay preserves null and empty scopes from the authenticated session", () => {
  const handlers = new Map();
  const relays = [];
  const app = {
    get: (route, handler) => handlers.set(`GET ${route}`, handler),
    post: (route, handler) => handlers.set(`POST ${route}`, handler),
  };
  const http = {
    request(options, callback) {
      const relay = { options, body: "", on() { return this; }, write(value) { this.body += value; }, end() { relays.push(this); } };
      return relay;
    },
  };
  registerAgentProxyRoutes({ app, http, agentPort: 4099, agentProxySecret: secret, errorResponse() {} });

  const requestBody = { goal: "read project status" };
  const requestPathWithQuery = "/api/agent/run?source=dashboard";
  for (const scopes of [undefined, []]) {
    handlers.get("POST /api/agent/run")({
      authPrincipal: { principal_id: "principal-test", ...(scopes === undefined ? {} : { scopes }) },
      originalUrl: requestPathWithQuery,
      body: requestBody,
    }, { headersSent: false, end() {} });
  }
  assert.equal(relays.length, 2);
  const roleIdentity = verifyAgentProxyRequest({ secret, method, path: requestPathWithQuery, body: relays[0].body, headers: relays[0].options.headers, now: Date.now(), usedNonces: new Map() });
  const credentialIdentity = verifyAgentProxyRequest({ secret, method, path: requestPathWithQuery, body: relays[1].body, headers: relays[1].options.headers, now: Date.now(), usedNonces: new Map() });
  assert.equal(roleIdentity.scopes, null);
  assert.deepEqual(credentialIdentity.scopes, []);
});
