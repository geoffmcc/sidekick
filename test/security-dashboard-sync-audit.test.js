"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-sync-audit-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const { registerSyncRoutes } = require("../src/dashboard/sync-routes");
test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const actor = require('./helpers/authorized-identity').createPrincipal(identity, { type: "human", displayName: "Sync audit owner" });

const handlers = new Map();
const app = {
  get: (route, handler) => handlers.set(`GET ${route}`, handler),
  post: (route, handler) => handlers.set(`POST ${route}`, handler),
};
const fileAudit = [];
let failRequestAudit = false;
let failCompletionAudit = false;
registerSyncRoutes({
  app,
  dbStore,
  requireIdentityPermission: () => true,
  projectAccess: { hasGlobalMemoryAccess: (_principalId, access) => access === "write", hasProjectAccess: () => false },
  auditLog: (_req, action) => {
    fileAudit.push(action);
    if (failRequestAudit && action.endsWith(".requested")) throw new Error("synthetic request audit failure");
    if (failCompletionAudit && !action.endsWith(".requested")) throw new Error("synthetic completion audit failure");
  },
  recordIdentityAudit: identity.recordAuditEvent,
  errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
});

function invoke(handler, request = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handler({ query: {}, body: {}, params: {}, authPrincipal: actor, ...request }, res);
  return res;
}

function payload(content) {
  return {
    version: 2,
    machine_id: `remote-${content}`,
    user_id: "remote-user",
    memories: [{ type: "fact", project: "sync_audit", content, summary: content, confidence: 0.8, source: "sync", updated_at: new Date().toISOString(), origin_machine_id: `remote-${content}` }],
  };
}

function hasMemory(content) {
  return Boolean(dbStore.getDb().prepare("SELECT 1 FROM memories WHERE content = ?").get(content));
}

test("sync import fails closed when the request audit sink is unavailable", () => {
  const content = "sync audit request failure canary";
  failRequestAudit = true;
  const response = invoke(handlers.get("POST /api/sync/import"), { body: { data: payload(content) } });
  failRequestAudit = false;
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(hasMemory(content), false);
});

test("sync import rejects malformed payloads before starting an audited mutation", () => {
  const existingAuditCount = fileAudit.length;
  const response = invoke(handlers.get("POST /api/sync/import"), { body: { data: { unexpected: true } } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "invalid_request");
  assert.equal(fileAudit.length, existingAuditCount);
});

test("sync import rolls back memory writes when actor audit insertion fails", () => {
  const content = "sync identity audit rollback canary";
  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_sync_audit BEFORE INSERT ON identity_audit_events WHEN NEW.event_type = 'dashboard.sync.imported' BEGIN SELECT RAISE(ABORT, 'synthetic sync audit failure'); END`);
  const response = invoke(handlers.get("POST /api/sync/import"), { body: { data: payload(content) } });
  dbStore.getDb().exec("DROP TRIGGER reject_sync_audit");
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(hasMemory(content), false);
});

test("sync import commits actor audit atomically and reports a degraded JSONL completion sink", () => {
  const content = "sync identity audit success canary";
  failCompletionAudit = true;
  const response = invoke(handlers.get("POST /api/sync/import"), { body: { data: payload(content) } });
  failCompletionAudit = false;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.equal(hasMemory(content), true);
  const event = dbStore.getDb().prepare("SELECT actor_principal_id, details_json FROM identity_audit_events WHERE event_type = 'dashboard.sync.imported' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(event.actor_principal_id, actor.principal_id);
  assert.equal(JSON.parse(event.details_json).imported, 1);
});

test("sync import is refused when no transactional identity audit writer is configured", () => {
  const noAuditHandlers = new Map();
  registerSyncRoutes({
    app: {
      get: (route, handler) => noAuditHandlers.set(`GET ${route}`, handler),
      post: (route, handler) => noAuditHandlers.set(`POST ${route}`, handler),
    },
    dbStore,
    requireIdentityPermission: () => true,
    projectAccess: { hasGlobalMemoryAccess: () => true },
    auditLog: () => {},
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });
  const content = "sync missing audit writer canary";
  const response = invoke(noAuditHandlers.get("POST /api/sync/import"), { body: { data: payload(content) } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(hasMemory(content), false);
});

test("sync identity update writes its request audit before changing the user ID", () => {
  const existing = dbStore.getUserId();
  failRequestAudit = true;
  const response = invoke(handlers.get("POST /api/sync/identity"), { body: { user_id: "sync-user-request-fail" } });
  failRequestAudit = false;
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(dbStore.getUserId(), existing);
});

test("sync identity update rolls back when its actor audit cannot be committed", () => {
  const existing = dbStore.getUserId();
  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_sync_identity_audit BEFORE INSERT ON identity_audit_events WHEN NEW.event_type = 'dashboard.sync.identity.updated' BEGIN SELECT RAISE(ABORT, 'synthetic sync identity audit failure'); END`);
  const response = invoke(handlers.get("POST /api/sync/identity"), { body: { user_id: "sync-user-identity-fail" } });
  dbStore.getDb().exec("DROP TRIGGER reject_sync_identity_audit");
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(dbStore.getUserId(), existing);
});

test("sync identity update commits actor audit atomically and reports degraded completion logging", () => {
  failCompletionAudit = true;
  const response = invoke(handlers.get("POST /api/sync/identity"), { body: { user_id: "sync-user-identity-success" } });
  failCompletionAudit = false;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.equal(dbStore.getUserId(), "sync-user-identity-success");
  const event = dbStore.getDb().prepare("SELECT actor_principal_id, details_json FROM identity_audit_events WHERE event_type = 'dashboard.sync.identity.updated' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(event.actor_principal_id, actor.principal_id);
  assert.equal(JSON.parse(event.details_json).user_id, "sync-user-identity-success");
});
