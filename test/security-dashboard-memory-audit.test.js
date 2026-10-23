"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-memory-audit-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const { registerMemoryMutationRoutes } = require("../src/dashboard/memory-mutation-routes");
const actor = require('./helpers/authorized-identity').createPrincipal(identity, { type: "human", displayName: "Memory audit owner" });
test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const handlers = new Map();
const auditEvents = [];
let failRequestAudit = false;
let failCompletionAudit = false;
const app = { post: (route, handler) => handlers.set(`POST ${route}`, handler) };
registerMemoryMutationRoutes({
  app,
  dbStore,
  projectAccess: { hasProjectAccess: () => true },
  requireIdentityAdministrator: () => true,
  auditLog: (_req, action) => {
    auditEvents.push(action);
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
  handler({ params: {}, body: {}, authPrincipal: actor, ...request }, res);
  return res;
}

function createMemory(content) {
  return dbStore.upsertMemory({ type: "fact", project: "memory_audit", content, summary: content, source: "test", confidence: 0.8 });
}

function identityAudit(eventType) {
  return dbStore.getDb().prepare("SELECT actor_principal_id, details_json FROM identity_audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1").get(eventType);
}

test("memory enable does not mutate when its request audit cannot be written", () => {
  const memory = createMemory("memory enable request audit canary");
  dbStore.disableMemory(memory.id);
  failRequestAudit = true;
  const response = invoke(handlers.get("POST /api/memories/:id/enable"), { params: { id: memory.id } });
  failRequestAudit = false;
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(dbStore.getMemoryById(memory.id).enabled, false);
});

test("memory enable rolls back when actor audit insertion fails", () => {
  const memory = createMemory("memory enable actor audit rollback canary");
  dbStore.disableMemory(memory.id);
  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_memory_enable_audit BEFORE INSERT ON identity_audit_events WHEN NEW.event_type = 'dashboard.memory.enabled' BEGIN SELECT RAISE(ABORT, 'synthetic memory enable audit failure'); END`);
  const response = invoke(handlers.get("POST /api/memories/:id/enable"), { params: { id: memory.id } });
  dbStore.getDb().exec("DROP TRIGGER reject_memory_enable_audit");
  assert.equal(response.statusCode, 503);
  assert.equal(dbStore.getMemoryById(memory.id).enabled, false);
});

test("memory enable commits the actor event and reports a degraded completion sink", () => {
  const memory = createMemory("memory enable success canary");
  dbStore.disableMemory(memory.id);
  failCompletionAudit = true;
  const response = invoke(handlers.get("POST /api/memories/:id/enable"), { params: { id: memory.id } });
  failCompletionAudit = false;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.equal(dbStore.getMemoryById(memory.id).enabled, true);
  assert.equal(identityAudit("dashboard.memory.enabled").actor_principal_id, actor.principal_id);
});

test("stale memory expiry rolls back if its actor audit cannot be committed", () => {
  const memory = createMemory("memory expiry rollback canary");
  const stale = new Date(Date.now() - 200 * 86400000).toISOString();
  dbStore.getDb().prepare("UPDATE memories SET enabled = 1, last_seen_at = ?, last_confirmed_at = ? WHERE id = ?").run(stale, stale, memory.id);
  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_memory_expiry_audit BEFORE INSERT ON identity_audit_events WHEN NEW.event_type = 'dashboard.memory.expired_stale' BEGIN SELECT RAISE(ABORT, 'synthetic memory expiry audit failure'); END`);
  const response = invoke(handlers.get("POST /api/memories/expire"), { body: { stale_days: 90 } });
  dbStore.getDb().exec("DROP TRIGGER reject_memory_expiry_audit");
  assert.equal(response.statusCode, 503);
  assert.equal(dbStore.getMemoryById(memory.id).enabled, true);
});

test("stale memory expiry commits the actor event and reports degraded completion logging", () => {
  const memory = createMemory("memory expiry success canary");
  const stale = new Date(Date.now() - 200 * 86400000).toISOString();
  dbStore.getDb().prepare("UPDATE memories SET enabled = 1, last_seen_at = ?, last_confirmed_at = ? WHERE id = ?").run(stale, stale, memory.id);
  failCompletionAudit = true;
  const response = invoke(handlers.get("POST /api/memories/expire"), { body: { stale_days: 90 } });
  failCompletionAudit = false;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.equal(response.body.expired, 1);
  assert.equal(dbStore.getMemoryById(memory.id).enabled, false);
  assert.equal(identityAudit("dashboard.memory.expired_stale").actor_principal_id, actor.principal_id);
});
