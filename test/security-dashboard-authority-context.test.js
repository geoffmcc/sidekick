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
  let credentialReads = 0;
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
    app, dbStore: {}, identity: {}, authentication: { isSessionActive: () => sessionActive, listCredentials: () => { credentialReads++; return []; } }, authorization,
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
  const expiredRoute = response();
  handlers.get("GET /api/auth/credentials")({
    authPrincipal: { ...streamPrincipal, scopes: ["credentials.read"] }, query: {},
  }, expiredRoute);
  assert.equal(expiredRoute.statusCode, 401, "route authorization revalidates the server-side session");
  assert.equal(credentialReads, 0, "an invalidated session is denied before credential metadata is read");
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

test("user creation cannot assign a role without roles.manage", () => {
  const handlers = new Map();
  let createdUsers = 0;
  let assignedRoles = 0;
  const app = Object.fromEntries(["get", "post", "put", "patch", "delete"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  app.use = () => {};
  const authorization = {
    authorize({ permission }) {
      return { ok: permission === "users.manage", code: permission === "users.manage" ? "allowed" : "forbidden" };
    },
  };
  registerAuthRoutes({
    app,
    dbStore: {},
    identity: {
      createHumanUser() { createdUsers++; return { principal_id: "new-user" }; },
      assignRole() { assignedRoles++; },
    },
    authentication: { isSessionActive: () => true },
    authorization,
    timingSafeCompare: () => false,
    dashboardUser: "",
    dashboardPass: "",
    bootstrapCompleted: () => true,
    authAttemptKeys: () => [],
    rejectIfAuthThrottled: () => false,
    recordAuthFailure() {},
    clearAuthFailures() {},
    legacyDashboardPrincipal: () => null,
    setIdentityCookie() {},
    clearIdentityCookie() {},
    requestCookie: () => null,
    bootstrapToken: null,
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });

  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() { return this; },
  };
  handlers.get("POST /api/auth/users")({
    authPrincipal: { principal_id: "limited-admin", principal_type: "human", scopes: null },
    body: { username: "new-admin", password: "synthetic sufficiently long password", role: "administrator" },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(createdUsers, 0, "authorization is checked before account creation");
  assert.equal(assignedRoles, 0, "unauthorized role assignment never executes");
});

test("adopted Dashboard owner promotion bypass applies only before first Owner setup", () => {
  const handlers = new Map();
  let assignedRoles = 0;
  const app = Object.fromEntries(["get", "post", "put", "patch", "delete"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  app.use = () => {};
  registerAuthRoutes({
    app,
    dbStore: {},
    identity: {
      canCompleteFirstOwnerSetup: () => false,
      assignRole() { assignedRoles++; return {}; },
    },
    authentication: { isSessionActive: () => true },
    authorization: { authorize: () => ({ ok: false, code: "forbidden" }) },
    timingSafeCompare: () => false,
    dashboardUser: "", dashboardPass: "", bootstrapCompleted: () => true,
    authAttemptKeys: () => [], rejectIfAuthThrottled: () => false,
    recordAuthFailure() {}, clearAuthFailures() {}, legacyDashboardPrincipal: () => null,
    setIdentityCookie() {}, clearIdentityCookie() {}, requestCookie: () => null,
    bootstrapToken: null,
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });

  const res = response();
  handlers.get("POST /api/auth/principals/:id/roles")({
    authPrincipal: {
      principal_id: "adopted-user", principal_type: "human",
      metadata: { adopted_legacy_dashboard: true },
    },
    params: { id: "adopted-user" },
    body: { role: "owner" },
  }, res);
  assert.equal(res.statusCode, 403, "legacy metadata cannot bypass roles.manage after Owner setup");
  assert.equal(assignedRoles, 0, "denied self-promotion must not reach the identity mutation");
});
