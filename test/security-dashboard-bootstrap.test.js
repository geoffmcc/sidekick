"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { requiresBootstrapToken } = require("../src/security/dashboard-bootstrap");
const { registerAuthRoutes } = require("../src/dashboard/auth-routes");

function registerRoutes(overrides = {}) {
  const routes = new Map();
  const app = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
    put: (route, handler) => routes.set(`PUT ${route}`, handler),
    delete: (route, handler) => routes.set(`DELETE ${route}`, handler),
    use: () => {},
  };
  const calls = { bootstrap: 0 };
  registerAuthRoutes({
    app,
    dbStore: {}, identity: {
      bootstrapOwner() { calls.bootstrap++; return { principal_id: "owner-test" }; },
      ...overrides.identity,
    },
    authentication: { createSession: () => ({ token: "synthetic-session", expires_at: "later" }) },
    authorization: {}, timingSafeCompare: (actual, expected) => actual === expected,
    dashboardUser: "", dashboardPass: "", bootstrapCompleted: () => false,
    authAttemptKeys: () => [], rejectIfAuthThrottled: () => false,
    recordAuthFailure: () => {}, clearAuthFailures: () => {}, legacyDashboardPrincipal: () => null,
    setIdentityCookie: () => {}, clearIdentityCookie: () => {}, requestCookie: () => null,
    bootstrapToken: "synthetic-bootstrap-token",
    remoteBootstrapAllowed: overrides.remoteBootstrapAllowed ?? true,
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });
  return { handler: routes.get("POST /api/auth/bootstrap"), calls };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("bootstrap token is required for trusted reverse proxies and non-loopback binds", () => {
  assert.equal(requiresBootstrapToken("127.0.0.1", false), false, "direct local bootstrap remains available");
  assert.equal(requiresBootstrapToken("localhost", false), false);
  assert.equal(requiresBootstrapToken("127.0.0.1", true), true, "loopback behind a trusted proxy is remotely reachable");
  assert.equal(requiresBootstrapToken("10.0.0.4", false), true);
  assert.equal(requiresBootstrapToken("0.0.0.0", false), true);
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.js"), "utf8");
  assert.match(dashboard, /requiresBootstrapToken\(BIND_HOST, TRUST_PROXY\)/, "runtime bootstrap policy must include trusted-proxy reachability");
});

test("remote bootstrap rejects missing or invalid tokens before owner creation", async () => {
  const { handler, calls } = registerRoutes();
  for (const body of [{}, { bootstrap_token: "wrong" }]) {
    const res = response();
    await handler({ body }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.bootstrap, 0);
  }
});

test("remote bootstrap accepts the configured token and creates the initial owner", async () => {
  const { handler, calls } = registerRoutes();
  const res = response();
  await handler({ body: { bootstrap_token: "synthetic-bootstrap-token" }, headers: {}, ip: "127.0.0.1" }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(calls.bootstrap, 1);
});
