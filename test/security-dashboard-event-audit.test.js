"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-event-audit-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const kernel = require("../src/platform/kernel");
kernel.ensurePlatformKernelSchema();
const identity = require("../src/core/identity");
const { registerEventRoutes } = require("../src/dashboard/event-routes");
const actor = require('./helpers/authorized-identity').createPrincipal(identity, { type: "human", displayName: "Event audit owner" });
test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const handlers = new Map();
const app = {
  get: (route, handler) => handlers.set(`GET ${route}`, handler),
  post: (route, handler) => handlers.set(`POST ${route}`, handler),
};
let failRequestAudit = false;
let failCompletionAudit = false;
registerEventRoutes({
  app,
  platformKernel: kernel,
  authenticatedUser: () => actor.display_name,
  requireIdentityPermission: () => true,
  recordIdentityAudit: identity.recordAuditEvent,
  auditLog: (_req, action) => {
    if (failRequestAudit && action.endsWith(".requested")) throw new Error("synthetic event request audit failure");
    if (failCompletionAudit && !action.endsWith(".requested")) throw new Error("synthetic event completion audit failure");
  },
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

function auditRow(eventType) {
  return dbStore.getDb().prepare("SELECT actor_principal_id, details_json FROM identity_audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1").get(eventType);
}

function createDeadLetterDelivery() {
  const subscription = kernel.registerEventSubscription({ name: `test-${Math.random()}`, event_type: "test.audit", max_attempts: 1 });
  const event = kernel.appendEvent({ event_type: "test.audit", source: "security-test", payload: { canary: true } });
  const delivery = kernel.listEventDeliveries({ subscription_id: subscription.subscription_id, limit: 10 })[0];
  kernel.claimEventDelivery(delivery.delivery_id);
  return kernel.completeEventDelivery(delivery.delivery_id, { ok: false, error: "synthetic failed delivery" });
}

test("event subscription request audit failure prevents creation", () => {
  const before = kernel.listEventSubscriptions().length;
  failRequestAudit = true;
  const response = invoke(handlers.get("POST /api/event-subscriptions"), { body: { name: "audit request fail", event_type: "test.audit" } });
  failRequestAudit = false;
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(kernel.listEventSubscriptions().length, before);
});

test("event subscription and actor audit commit atomically", () => {
  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_subscription_audit BEFORE INSERT ON identity_audit_events WHEN NEW.event_type = 'dashboard.event_subscription.registered' BEGIN SELECT RAISE(ABORT, 'synthetic subscription audit failure'); END`);
  const response = invoke(handlers.get("POST /api/event-subscriptions"), { body: { name: "audit tx failure", event_type: "test.audit" } });
  dbStore.getDb().exec("DROP TRIGGER reject_subscription_audit");
  assert.equal(response.statusCode, 503);
  assert.equal(kernel.listEventSubscriptions().some(item => item.name === "audit tx failure"), false);
});

test("subscription creation records actor identity despite completion sink failure", () => {
  failCompletionAudit = true;
  const response = invoke(handlers.get("POST /api/event-subscriptions"), { body: { name: "audit success", event_type: "test.audit" } });
  failCompletionAudit = false;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  const event = auditRow("dashboard.event_subscription.registered");
  assert.equal(event.actor_principal_id, actor.principal_id);
  assert.equal(JSON.parse(event.details_json).subscription_id, response.body.subscription.subscription_id);
});

test("subscription pause rolls back when actor audit insertion fails", () => {
  const subscription = kernel.registerEventSubscription({ name: "pause audit failure", event_type: "test.audit" });
  kernel.setEventSubscriptionState(subscription.subscription_id, "paused");
  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_subscription_resume_audit BEFORE INSERT ON identity_audit_events WHEN NEW.event_type = 'dashboard.event_subscription.resume' BEGIN SELECT RAISE(ABORT, 'synthetic subscription resume audit failure'); END`);
  const response = invoke(handlers.get("POST /api/event-subscriptions/:subscriptionId/:action"), { params: { subscriptionId: subscription.subscription_id, action: "resume" } });
  dbStore.getDb().exec("DROP TRIGGER reject_subscription_resume_audit");
  assert.equal(response.statusCode, 503);
  assert.equal(kernel.listEventSubscriptions().find(item => item.subscription_id === subscription.subscription_id).state, "paused");
});

test("dead-letter requeue rolls back if actor audit insertion fails", () => {
  const delivery = createDeadLetterDelivery();
  assert.equal(delivery.status, "dead_letter");
  dbStore.getDb().exec(`CREATE TEMP TRIGGER reject_requeue_audit BEFORE INSERT ON identity_audit_events WHEN NEW.event_type = 'dashboard.event_delivery.requeued' BEGIN SELECT RAISE(ABORT, 'synthetic delivery requeue audit failure'); END`);
  const response = invoke(handlers.get("POST /api/event-deliveries/:deliveryId/requeue"), { params: { deliveryId: delivery.delivery_id } });
  dbStore.getDb().exec("DROP TRIGGER reject_requeue_audit");
  assert.equal(response.statusCode, 503);
  assert.equal(kernel.listEventDeliveries({ status: "dead_letter", limit: 10 }).some(item => item.delivery_id === delivery.delivery_id), true);
});
