const test = require("node:test");
const assert = require("node:assert/strict");
const { registerAuthRoutes } = require("../src/dashboard/auth-routes");

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() { return this; },
  };
}

test("Dashboard authorization preserves credential and delegation attenuation", () => {
  const handlers = new Map();
  const decisions = [];
  let createdDelegations = 0;
  let revokedDelegations = 0;
  let sessionActive = true;
  const app = Object.fromEntries(["get", "post", "put", "patch", "delete"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  app.use = () => {};
  const authorization = {
    authorize(input) {
      decisions.push(input);
      if (input.delegationId && input.permission !== "workflows.execute") return { ok: false, code: "forbidden" };
      if (Array.isArray(input.credentialScopes) && !input.credentialScopes.includes(input.permission)) return { ok: false, code: "forbidden" };
      return { ok: true, code: "allowed" };
    },
    createDelegation() { createdDelegations++; return { delegation_id: "unexpected" }; },
    getDelegation() { return { delegation_id: "other-delegation", delegator_principal_id: "other-principal" }; },
    revokeDelegation() { revokedDelegations++; return {}; },
  };
  const { hasIdentityPermission } = registerAuthRoutes({
    app, dbStore: {}, identity: {}, authentication: { isSessionActive: () => sessionActive }, authorization,
    timingSafeCompare: () => false, dashboardUser: "", dashboardPass: "",
    bootstrapCompleted: () => false, authAttemptKeys: () => [], rejectIfAuthThrottled: () => false,
    recordAuthFailure() {}, clearAuthFailures() {}, legacyDashboardPrincipal: () => null,
    setIdentityCookie() {}, clearIdentityCookie() {}, requestCookie: () => null,
    bootstrapToken: null,
    errorResponse: (_req, res, error, options) => res.status(options.status).json({ code: options.code }),
  });

  const principal = { principal_id: "agent-1", scopes: ["principals.read"], delegation_id: "delegation-1" };
  const streamPrincipal = { principal_id: "user-1", scopes: ["dashboard.operations.read"], session_id: "a".repeat(64) };
  assert.equal(hasIdentityPermission({ authPrincipal: streamPrincipal }, "dashboard.operations.read"), true);
  sessionActive = false;
  assert.equal(hasIdentityPermission({ authPrincipal: streamPrincipal }, "dashboard.operations.read"), false, "invalidated server-side sessions cannot retain long-lived stream access");
  sessionActive = true;
  const credentialRead = response();
  handlers.get("GET /api/auth/credentials")({ authPrincipal: principal, query: {} }, credentialRead);
  assert.equal(credentialRead.statusCode, 403);
  assert.deepEqual(decisions.at(-1), {
    principalId: "agent-1", permission: "credentials.read",
    credentialScopes: ["principals.read"], delegationId: "delegation-1",
  });

  const delegationResponse = response();
  handlers.get("POST /api/auth/delegations")({
    authPrincipal: principal,
    body: { delegator_principal_id: "agent-1", delegate_principal_id: "agent-2", permissions: ["credentials.read"] },
  }, delegationResponse);
  assert.equal(delegationResponse.statusCode, 403);
  assert.equal(delegationResponse.body.code, "insufficient_delegation");
  assert.equal(createdDelegations, 0, "attenuated authority cannot be re-delegated beyond its scope");
  assert.ok(decisions.some(decision => decision.delegationId === "delegation-1" && decision.permission === "credentials.read"));

  const revokeResponse = response();
  handlers.get("POST /api/auth/delegations/:id/revoke")({
    authPrincipal: principal, params: { id: "other-delegation" },
  }, revokeResponse);
  assert.equal(revokeResponse.statusCode, 403);
  assert.equal(revokedDelegations, 0, "attenuated authority cannot revoke another principal's delegation");
});
