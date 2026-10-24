"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-project-scope-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const platformKernel = require("../src/platform/kernel");
const projectAccess = require("../src/core/project-access");
const { createOwnerContext } = require("./helpers/authorized-context");
const { registerProjectRoutes } = require("../src/dashboard/project-routes");

function projectRouteHandler() {
  let handler;
  registerProjectRoutes({
    app: { get: (route, callback) => { if (route === "/api/projects") handler = callback; } },
    platformKernel,
    projectAccess,
    errorResponse(_req, res) { return res.status(503).json({ ok: false }); },
  });
  assert.equal(typeof handler, "function");
  return handler;
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("Dashboard project workspace projection requires memory read authority", async t => {
  t.after(() => {
    db.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const ownerContext = createOwnerContext({ source: "dashboard" });
  const owner = identity.getPrincipal(ownerContext.authIdentity.principal_id);
  const visibleProject = "dashboard_workspace_visible";
  const hiddenProject = "dashboard_workspace_hidden";
  platformKernel.registerProject({ project_id: visibleProject, owner_actor_id: owner.principal_id, source: "test" });
  platformKernel.registerProject({ project_id: hiddenProject, owner_actor_id: owner.principal_id, source: "test" });
  platformKernel.createProjectWorkspace({ project_id: visibleProject, name: "Visible workspace" });
  platformKernel.createProjectWorkspace({ project_id: hiddenProject, name: "Hidden workspace" });

  const managerWithoutMemoryRead = identity.createPrincipal({
    type: "service",
    displayName: "Project manager without memory read",
    actorIdentity: owner,
  });
  identity.grantPrincipalPermission(managerWithoutMemoryRead.principal_id, "projects.access.manage", owner);
  const responseWithoutRead = response();
  projectRouteHandler()({
    authPrincipal: { principal_id: managerWithoutMemoryRead.principal_id, scopes: null },
    query: { limit: "10" },
  }, responseWithoutRead);
  assert.equal(responseWithoutRead.statusCode, 200);
  assert.deepEqual(responseWithoutRead.body.projects, []);

  const scopedReader = identity.createPrincipal({
    type: "service",
    displayName: "Project scoped reader",
    actorIdentity: owner,
  });
  identity.grantPrincipalPermission(scopedReader.principal_id, "memory.read", owner);
  projectAccess.grantProjectAccess({
    actorPrincipalId: owner.principal_id,
    principalId: scopedReader.principal_id,
    project: visibleProject,
    accessLevel: "read",
  });
  const responseScoped = response();
  projectRouteHandler()({
    authPrincipal: { principal_id: scopedReader.principal_id, scopes: null },
    query: { limit: "10" },
  }, responseScoped);
  assert.deepEqual(responseScoped.body.projects.map(row => row.project.project_id), [visibleProject]);
  assert.equal(responseScoped.body.projects[0].workspace.name, "Visible workspace");
});
