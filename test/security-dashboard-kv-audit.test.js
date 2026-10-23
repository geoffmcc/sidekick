"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-kv-audit-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const { registerKvRoutes } = require("../src/dashboard/kv-routes");
const actor = require('./helpers/authorized-identity').createPrincipal(identity, { type: "human", displayName: "KV audit test owner" });

const handlers = new Map();
const app = Object.fromEntries(["get", "put", "delete"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
const fileAudit = [];
let failRequestAudit = false;
let failCompletionAudit = false;
registerKvRoutes({
  app,
  dbStore,
  safeString: value => String(value),
  summarizeValue: value => String(value),
  inferNamespace: () => "test",
  valueSize: () => 0,
  valueType: () => "string",
  auditLog: (_req, action) => {
    fileAudit.push(action);
    if (failRequestAudit && action.endsWith(".requested")) throw new Error("synthetic file audit failure");
    if (failCompletionAudit && !action.endsWith(".requested")) throw new Error("synthetic completion audit failure");
  },
  recordIdentityAudit: identity.recordAuditEvent,
  requireIdentityAdministrator: () => true,
  requireIdentityPermission: () => true,
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

function auditRows(eventType) {
  return dbStore.getDb().prepare("SELECT event_type, actor_principal_id, details_json FROM identity_audit_events WHERE event_type = ? ORDER BY created_at, event_id").all(eventType);
}

test("Dashboard KV mutation requires write-ahead audit and atomically commits the actor event", () => {
  dbStore.setKV("kv-audit-canary", "before", "project-a", "test", "system");
  const update = handlers.get("PUT /api/kv/:key");
  const request = { params: { key: "kv-audit-canary" }, body: { value: "after" } };
  const existingAuditCount = auditRows("dashboard.kv.updated").length;

  failRequestAudit = true;
  const deniedBeforeMutation = invoke(update, request);
  failRequestAudit = false;
  assert.equal(deniedBeforeMutation.statusCode, 503);
  assert.equal(deniedBeforeMutation.body.code, "audit_unavailable");
  assert.equal(dbStore.getKV("kv-audit-canary").value, "before");
  assert.equal(auditRows("dashboard.kv.updated").length, existingAuditCount);

  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_kv_update_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'dashboard.kv.updated' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
  const deniedByDurableAudit = invoke(update, request);
  dbStore.getDb().exec("DROP TRIGGER reject_kv_update_audit");
  assert.equal(deniedByDurableAudit.statusCode, 503);
  assert.equal(deniedByDurableAudit.body.code, "audit_unavailable");
  assert.equal(dbStore.getKV("kv-audit-canary").value, "before", "failed durable audit must roll back the KV write");
  assert.equal(auditRows("dashboard.kv.updated").length, existingAuditCount);

  failCompletionAudit = true;
  const committedWithDegradedFileAudit = invoke(update, request);
  failCompletionAudit = false;
  assert.equal(committedWithDegradedFileAudit.statusCode, 200);
  assert.equal(committedWithDegradedFileAudit.body.audit_status, "degraded");
  assert.equal(dbStore.getKV("kv-audit-canary").value, "after");
  const updateAudit = auditRows("dashboard.kv.updated").at(-1);
  assert.equal(updateAudit.actor_principal_id, actor.principal_id);
  assert.deepEqual(JSON.parse(updateAudit.details_json), {
    key: "kv-audit-canary", value_length: 5, project: null,
  });
  assert.ok(fileAudit.includes("kv.update.requested"));
});

test("Dashboard KV delete rolls back if its actor audit cannot be committed", () => {
  dbStore.setKV("kv-delete-canary", "before", "project-a", "test", "system");
  const remove = handlers.get("DELETE /api/kv/:key");
  const request = { params: { key: "kv-delete-canary" } };
  const auditCount = auditRows("dashboard.kv.deleted").length;

  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_kv_delete_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'dashboard.kv.deleted' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
  const response = invoke(remove, request);
  dbStore.getDb().exec("DROP TRIGGER reject_kv_delete_audit");
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(dbStore.getKV("kv-delete-canary").value, "before", "failed durable audit must roll back the KV delete");
  assert.equal(auditRows("dashboard.kv.deleted").length, auditCount);
});

test.after(() => {
  try { dbStore.closeDatabase(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});
