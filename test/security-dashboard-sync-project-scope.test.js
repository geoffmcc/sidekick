"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-sync-project-"));
process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.NODE_ENV = "test";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authorization = require("../src/core/authorization");
const projectAccess = require("../src/core/project-access");
const platformKernel = require("../src/platform/kernel");
const { registerSyncRoutes } = require("../src/dashboard/sync-routes");

const owner = identity.bootstrapOwner({ username: "dashboard_sync_scope_owner", password: "synthetic sufficiently long password" });
const operator = identity.createHumanUser({ username: "dashboard_sync_scope_operator", password: "synthetic sufficiently long password" });
identity.assignRole(operator.principal_id, "operator", owner.principal_id);
platformKernel.registerProject({ project_id: "dashboard_sync_scope_project", owner_actor_id: owner.principal_id });
projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "dashboard_sync_scope_project", accessLevel: "write" });

const routes = new Map();
registerSyncRoutes({
  app: { get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) },
  dbStore: db,
  requireIdentityPermission(req, res, permission) {
    const decision = authorization.authorize({ principalId: req.authPrincipal?.principal_id, permission, credentialScopes: req.authPrincipal?.scopes, delegationId: req.authPrincipal?.delegation_id });
    if (!decision.ok) res.status(403).json({ ok: false, error: "forbidden", code: "authorization_denied" });
    return decision.ok;
  },
  projectAccess,
  auditLog: () => {},
  recordIdentityAudit: identity.recordAuditEvent,
  errorResponse: (_req, res, _error, options) => res.status(options.status).json({ ok: false, code: options.code }),
});

function invoke(route, { query = {}, body = {} } = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  routes.get(route)({ query, body, authPrincipal: { principal_id: operator.principal_id, principal_type: "human", scopes: null } }, res);
  return res;
}

test.after(() => {
  db.closeDatabase();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("project members can sync only their project through Dashboard without global sync grants", () => {
  const project = "dashboard_sync_scope_project";
  assert.equal(authorization.authorize({ principalId: operator.principal_id, permission: "sync.read" }).ok, false);
  assert.equal(authorization.authorize({ principalId: operator.principal_id, permission: "sync.manage" }).ok, false);

  const exported = invoke("GET /api/sync/export", { query: { project } });
  assert.equal(exported.statusCode, 200);
  assert.ok(exported.body.data);

  const diff = invoke("GET /api/sync/diff", { query: { project, since: "2000-01-01T00:00:00.000Z" } });
  assert.equal(diff.statusCode, 200);

  const imported = invoke("POST /api/sync/import", { body: {
    project,
    data: { memories: [{ type: "fact", project, content: "synthetic dashboard project sync", confidence: 0.8 }] },
  } });
  assert.equal(imported.statusCode, 200);
  assert.ok(db.searchMemories({ project, query: "synthetic dashboard project sync" }).length > 0);
});

test("global sync and identity remain restricted to dedicated grants", () => {
  const beforeUserId = db.getUserId();
  const exportResult = invoke("GET /api/sync/export");
  const identityResult = invoke("GET /api/sync/identity");
  const importResult = invoke("POST /api/sync/import", { body: { data: { memories: [] } } });
  const updateResult = invoke("POST /api/sync/identity", { body: { user_id: "unauthorized-global-sync" } });
  for (const result of [exportResult, identityResult, importResult, updateResult]) {
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.code, "authorization_denied");
  }
  assert.equal(db.getUserId(), beforeUserId);
});
