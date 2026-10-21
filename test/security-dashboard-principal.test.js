const assert = require("node:assert/strict");
const { registerAuthRoutes } = require("../src/dashboard/auth-routes");

function middlewareFor(legacyDashboardPrincipal) {
  let middleware;
  const app = {
    get() {},
    post() {},
    put() {},
    patch() {},
    delete() {},
    use(handler) { middleware = handler; },
  };
  registerAuthRoutes({
    app,
    dbStore: {}, identity: {}, authentication: { getSession: () => null }, authorization: {},
    timingSafeCompare: (a, b) => a === b,
    dashboardUser: "owner", dashboardPass: "correct-password",
    bootstrapCompleted: () => true,
    authAttemptKeys: () => ["test"], rejectIfAuthThrottled: () => false,
    recordAuthFailure() {}, clearAuthFailures() {}, legacyDashboardPrincipal,
    setIdentityCookie() {}, clearIdentityCookie() {}, requestCookie: () => null,
    bootstrapToken: null,
  });
  return middleware;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

for (const auth of ["basic", "legacy-session"]) {
  const middleware = auth === "basic"
    ? middlewareFor(() => null)
    : middlewareFor(() => null);
  const req = {
    path: "/api/compute/recover",
    headers: auth === "basic"
      ? { authorization: `Basic ${Buffer.from("owner:correct-password").toString("base64")}` }
      : { cookie: "sidekick_sid=valid" },
  };
  const res = response();
  middleware(req, res, () => assert.fail("must not continue without an authorized principal"));
  if (auth === "basic") {
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "identity_unavailable");
  } else {
    assert.equal(res.statusCode, 401, "retired stateless cookies must not authenticate");
  }
  assert.equal(req.authPrincipal, undefined);
  assert.equal(req.authUser, undefined);
}

console.log("Dashboard compatibility authentication fails closed when principal adoption fails or a retired stateless cookie is supplied.");
