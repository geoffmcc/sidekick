"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-knowledge-scope-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");

const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const platformKernel = require("../src/platform/kernel");
const { createOwnerContext } = require("./helpers/authorized-context");
const { registerKnowledgeRoute } = require("../src/dashboard/knowledge-route");

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("Dashboard global knowledge results require both project and knowledge authority", async t => {
  t.after(() => {
    dbStore.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const ownerContext = createOwnerContext({ source: "dashboard" });
  const owner = identity.getPrincipal(ownerContext.authIdentity.principal_id);
  const project = "dashboard_knowledge_private";
  platformKernel.registerProject({ project_id: project, owner_actor_id: owner.principal_id, source: "test" });
  const now = new Date().toISOString();
  const db = dbStore.getDb();
  db.prepare("INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at, project_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
    .run("architecture", "Private project knowledge", "Project-only synthetic content", "scope,test", now, now, project);
  db.prepare("INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run("general", "Global knowledge", "Unscoped synthetic content", "scope,test", now, now);

  const manager = identity.createPrincipal({
    type: "service",
    displayName: "Project manager without knowledge read",
    actorIdentity: owner,
  });
  identity.grantPrincipalPermission(manager.principal_id, "projects.access.manage", owner);

  let handler;
  registerKnowledgeRoute({
    app: { get: (route, callback) => { if (route === "/api/knowledge") handler = callback; } },
    dbStore,
    requireIdentityPermission: () => true,
    errorResponse(_req, res) { return res.status(500).json({ ok: false }); },
  });

  const beforeReadGrant = response();
  handler({ authPrincipal: { principal_id: manager.principal_id, scopes: null }, query: {} }, beforeReadGrant);
  assert.deepEqual(beforeReadGrant.body.knowledge.map(row => row.title), ["Global knowledge"]);

  identity.grantPrincipalPermission(manager.principal_id, "knowledge.read", owner);
  const afterReadGrant = response();
  handler({ authPrincipal: { principal_id: manager.principal_id, scopes: null }, query: {} }, afterReadGrant);
  assert.deepEqual(new Set(afterReadGrant.body.knowledge.map(row => row.title)), new Set([
    "Global knowledge",
    "Private project knowledge",
  ]));
});
