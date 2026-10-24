const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardMarkup = fs.readFileSync(path.join(__dirname, "../src/dashboard.html"), "utf8");
const dashboardClientCode = fs.readFileSync(path.join(__dirname, "../static/dashboard.js"), "utf8");

const dataDir = path.join(__dirname, `test-data-service-credential-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");
const projectAccess = require("../src/core/project-access");
const platformKernel = require("../src/platform/kernel");
const { registerAuthRoutes } = require("../src/dashboard/auth-routes");

const owner = identity.bootstrapOwner({ username: "service-owner", password: "correct horse battery staple", displayName: "Owner" });
const handlers = new Map();
const app = Object.fromEntries(["get", "post", "put", "patch", "delete"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
app.use = () => {};
registerAuthRoutes({
  app, dbStore, identity, authentication, authorization, projectAccess,
  timingSafeCompare: () => false, dashboardUser: "", dashboardPass: "",
  bootstrapCompleted: () => true, authAttemptKeys: () => [], rejectIfAuthThrottled: () => false,
  recordAuthFailure() {}, clearAuthFailures() {}, legacyDashboardPrincipal: () => null,
  setIdentityCookie() {}, clearIdentityCookie() {}, requestCookie: () => null,
  bootstrapToken: null,
  errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
});

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

test("MCP client setup distinguishes standard tool execution from pack permissions", () => {
  assert.match(dashboardMarkup, /Use standard tools \(low and medium risk\)/);
  assert.match(dashboardMarkup, /View and manage Capability Packs/);
  assert.match(dashboardMarkup, /Pack access is separate from standard tool execution[\s\S]*pack permissions alone do not grant that access/);
  assert.match(dashboardClientCode, /mcpGrantTools[^\n]*tools\.execute/);
  assert.match(dashboardClientCode, /mcpGrantPacks[^\n]*packs\.read', 'packs\.manage/);
  assert.match(dashboardMarkup, /mcpGrantMemoryRead[^>]*> Read memory and handoffs/);
  assert.match(dashboardMarkup, /mcpGrantMemoryWrite[^>]*> Save memory and handoffs/);
  assert.match(dashboardMarkup, /mcpGrantKnowledgeRead[^>]*> Search Sidekick knowledge/);
  assert.match(dashboardClientCode, /mcpGrantMemoryRead[^\n]*memory\.read/);
  assert.match(dashboardClientCode, /mcpGrantMemoryWrite[^\n]*memory\.write/);
  assert.match(dashboardClientCode, /mcpGrantKnowledgeRead[^\n]*knowledge\.read/);
  assert.match(dashboardClientCode, /mcpGrantCatalogRead[^\n]*tools\.catalog\.read/);
  assert.match(dashboardClientCode, /mcpGrantWorkflows[^\n]*workflows\.execute/);
  assert.match(dashboardMarkup, /mcpProjectAccess[^>]*multiple/);
  assert.match(dashboardMarkup, /Project grants are optional and require project access administration authority/);
  assert.match(dashboardClientCode, /authFetch\('\/api\/projects\?limit=200'\)/);
  assert.match(dashboardClientCode, /body\.project_grants = selectedProjects\.map/);
});

test("MCP service identities can receive explicitly selected continuity and discovery permissions", () => {
  const res = response();
  handlers.get("POST /api/auth/service-credentials")({
    authPrincipal: owner,
    body: {
      display_name: "Continuity-enabled MCP client",
      permissions: ["memory.read", "memory.write", "knowledge.read", "tools.catalog.read", "workflows.execute"],
      scopes: ["memory.read", "memory.write", "knowledge.read", "tools.catalog.read", "workflows.execute"],
    },
  }, res);

  assert.equal(res.statusCode, 201);
  const auth = authentication.authenticateCredential(res.body.token);
  for (const permission of ["memory.read", "memory.write", "knowledge.read", "tools.catalog.read", "workflows.execute"]) {
    assert.equal(authorization.authorize({ principalId: auth.principal_id, permission, credentialScopes: auth.scopes }).ok, true, `${permission} is effective when explicitly granted`);
  }
  assert.equal(authorization.authorize({ principalId: auth.principal_id, permission: "tools.execute_critical", credentialScopes: auth.scopes }).ok, false, "unselected critical execution remains denied");
});

test("MCP setup grants only selected project access atomically with the service credential", () => {
  const project = `credential_setup_${process.pid}`;
  platformKernel.registerProject({ project_id: project, owner_actor_id: owner.principal_id });
  const res = response();
  handlers.get("POST /api/auth/service-credentials")({
    authPrincipal: owner,
    body: {
      display_name: "Project-scoped MCP client",
      permissions: ["memory.read", "memory.write"],
      scopes: ["memory.read", "memory.write"],
      project_grants: [{ project_id: project, access_level: "write" }],
    },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.project_grants, [{ project_id: project, access_level: "write" }]);
  assert.equal(projectAccess.hasProjectAccess(res.body.principal.principal_id, project, "read", res.body.credential.scopes), true);
  assert.equal(projectAccess.hasProjectAccess(res.body.principal.principal_id, project, "write", res.body.credential.scopes), true);

  const missingProject = response();
  const before = identity.listPrincipals({ type: "service" }).length;
  handlers.get("POST /api/auth/service-credentials")({
    authPrincipal: owner,
    body: {
      display_name: "Must roll back",
      permissions: ["memory.read"],
      scopes: ["memory.read"],
      project_grants: [{ project_id: `missing_${process.pid}`, access_level: "write" }],
    },
  }, missingProject);
  assert.equal(missingProject.statusCode, 400);
  assert.equal(identity.listPrincipals({ type: "service" }).length, before, "failed project grant rolls back principal, grants, and credential");
});

test("MCP setup rejects project grants without current project access administration authority", () => {
  const limitedPrincipal = identity.createPrincipal({ type: "service", displayName: "Limited credential provisioner", actorIdentity: owner });
  for (const permission of ["principals.manage", "roles.manage", "credentials.create"]) identity.grantPrincipalPermission(limitedPrincipal.principal_id, permission, owner);
  const limited = authentication.createCredential({
    principalId: limitedPrincipal.principal_id,
    displayName: "Limited provisioner credential",
    scopes: ["principals.manage", "roles.manage", "credentials.create"],
    createdByPrincipalId: owner.principal_id,
    actorContext: owner,
  });
  const principalContext = authentication.authenticateBearerIdentity(limited.token);
  const before = identity.listPrincipals({ type: "service" }).length;
  const res = response();
  handlers.get("POST /api/auth/service-credentials")({
    authPrincipal: principalContext,
    body: {
      display_name: "Must be denied",
      permissions: ["credentials.create"],
      scopes: ["credentials.create"],
      project_grants: [{ project_id: "any_project", access_level: "read" }],
    },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(identity.listPrincipals({ type: "service" }).length, before, "denied project grant creates no identity or credential");
});

test("service credential provisioning is atomic, audited, narrowly scoped, and revocable", () => {
  const handler = handlers.get("POST /api/auth/service-credentials");
  const res = response();
  handler({
    authPrincipal: owner,
    body: {
      display_name: "Sidekick MCP pack manager",
      permissions: ["packs.read", "packs.manage"],
      scopes: ["packs.read", "packs.manage"],
    },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.body.principal.principal_type, "service");
  assert.equal(res.body.credential.expires_at, null);
  const auth = authentication.authenticateCredential(res.body.token);
  assert.equal(auth.principal_type, "service");
  assert.equal(authorization.authorize({ principalId: auth.principal_id, permission: "packs.manage", credentialScopes: auth.scopes }).ok, true);
  assert.equal(authorization.authorize({ principalId: auth.principal_id, permission: "tools.execute", credentialScopes: auth.scopes }).ok, false);
  assert.deepEqual(identity.getPrincipalPermissions(auth.principal_id), ["packs.manage", "packs.read"]);

  const status = response();
  handlers.get("GET /api/auth/service-credentials")({ authPrincipal: owner }, status);
  assert.equal(status.statusCode, 200);
  assert.ok(status.body.service_principals.some(principal => principal.principal_id === auth.principal_id));
  assert.equal(JSON.stringify(status.body).includes(res.body.token), false, "status never reveals a credential token");

  const audit = dbStore.getDb().prepare("SELECT event_type, actor_principal_id, details_json FROM identity_audit_events WHERE principal_id = ?").all(auth.principal_id);
  assert.ok(audit.some(row => row.event_type === "principal.permission_granted" && row.actor_principal_id === owner.principal_id));
  assert.ok(audit.some(row => row.event_type === "credential.created" && row.actor_principal_id === owner.principal_id));

  const denied = response();
  const principalsBeforeDeniedAttempt = identity.listPrincipals({ type: "service" }).length;
  handler({ authPrincipal: { ...auth, scopes: auth.scopes }, body: { display_name: "Escalation", permissions: ["packs.manage"] } }, denied);
  assert.equal(denied.statusCode, 403, "the resulting service identity cannot provision or expand its own authority");
  assert.equal(identity.listPrincipals({ type: "service" }).length, principalsBeforeDeniedAttempt, "denied provisioning creates no service principal");

  const rotated = response();
  const scopedRotation = response();
  handlers.get("POST /api/auth/service-credentials/:id/rotate")({
    authPrincipal: { ...owner, scopes: ["credentials.revoke"] },
    params: { id: res.body.credential.credential_id },
  }, scopedRotation);
  assert.equal(scopedRotation.statusCode, 403, "credential administration alone cannot mint a pack-management credential");
  handlers.get("POST /api/auth/service-credentials/:id/rotate")({
    authPrincipal: owner,
    params: { id: res.body.credential.credential_id },
  }, rotated);
  assert.equal(rotated.statusCode, 201);
  assert.equal(authentication.authenticateCredential(res.body.token), null, "rotation revokes the previous token");
  assert.deepEqual(authentication.authenticateCredential(rotated.body.token).scopes, ["packs.read", "packs.manage"]);

  identity.setPrincipalEnabled(auth.principal_id, false, owner);
  assert.equal(authentication.authenticateCredential(rotated.body.token), null, "disabling the service identity immediately invalidates its credential");
});

test("service credential provisioning rejects scopes outside the approved grants before creating state", () => {
  const before = identity.listPrincipals({ type: "service" }).length;
  const res = response();
  handlers.get("POST /api/auth/service-credentials")({
    authPrincipal: owner,
    body: { display_name: "Invalid scope", permissions: ["packs.read"], scopes: ["packs.manage"] },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(identity.listPrincipals({ type: "service" }).length, before);
});

test("generic credential routes cannot create, rotate, or revoke another principal's credential", () => {
  const administrator = require('./helpers/authorized-identity').createHumanUser(identity, {
    username: "credential_route_admin",
    password: "synthetic credential administrator password",
    actorPrincipalId: owner.principal_id,
  });
  identity.assignRole(administrator.principal_id, "administrator", owner);

  const before = authentication.listCredentials(owner.principal_id).length;
  const create = response();
  handlers.get("POST /api/auth/credentials")({
    authPrincipal: administrator,
    body: {
      principal_id: owner.principal_id,
      display_name: "Impersonation credential",
      scopes: ["secrets.read"],
    },
  }, create);
  assert.equal(create.statusCode, 403, "an Administrator cannot mint an Owner credential for a permission it does not hold");
  assert.equal(authentication.listCredentials(owner.principal_id).length, before);

  const outOfScope = response();
  handlers.get("POST /api/auth/credentials")({
    authPrincipal: administrator,
    body: {
      display_name: "Out-of-scope credential",
      scopes: ["secrets.read"],
    },
  }, outOfScope);
  assert.equal(outOfScope.statusCode, 403, "an Administrator cannot put Owner-only scopes on its own credential");
  assert.equal(authentication.listCredentials(administrator.principal_id).length, 0);

  const selfCredential = response();
  handlers.get("POST /api/auth/credentials")({
    authPrincipal: owner,
    body: {
      display_name: "Owner self credential",
      scopes: ["secrets.read"],
    },
  }, selfCredential);
  assert.equal(selfCredential.statusCode, 201, "the Owner retains credential creation within its own authority");
  assert.deepEqual(selfCredential.body.credential.scopes, ["secrets.read"]);

  const ownerCredential = authentication.createCredential({
    principalId: owner.principal_id,
    displayName: "Owner-only synthetic credential",
    scopes: ["secrets.read"],
    createdByPrincipalId: owner.principal_id,
    actorContext: owner,
  });
  const revoke = response();
  handlers.get("POST /api/auth/credentials/:id/revoke")({
    authPrincipal: administrator,
    params: { id: ownerCredential.credential.credential_id },
  }, revoke);
  assert.equal(revoke.statusCode, 403, "an Administrator cannot revoke another principal's credential");
  assert.ok(authentication.authenticateCredential(ownerCredential.token));

  const rotate = response();
  handlers.get("POST /api/auth/credentials/:id/rotate")({
    authPrincipal: administrator,
    params: { id: ownerCredential.credential.credential_id },
  }, rotate);
  assert.equal(rotate.statusCode, 403, "an Administrator cannot rotate another principal's credential");
  assert.ok(authentication.authenticateCredential(ownerCredential.token));
});

test("an MCP agent can receive standard tool access without pack-management authority", () => {
  const res = response();
  handlers.get("POST /api/auth/service-credentials")({
    authPrincipal: owner,
    body: {
      display_name: "Living room assistant",
      credential_name: "Living room assistant",
      permissions: ["tools.execute"],
      scopes: ["tools.execute"],
    },
  }, res);
  assert.equal(res.statusCode, 201);
  const auth = authentication.authenticateCredential(res.body.token);
  assert.equal(authorization.authorize({ principalId: auth.principal_id, permission: "tools.execute", credentialScopes: auth.scopes }).ok, true);
  assert.equal(authorization.authorize({ principalId: auth.principal_id, permission: "packs.manage", credentialScopes: auth.scopes }).ok, false);
  assert.deepEqual(auth.scopes, ["tools.execute"]);
});

test.after(() => {
  try { dbStore.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});
