"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-network-scope-atomicity-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete process.env.SIDEKICK_DB_FILE;
delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const kernel = require("../src/platform/kernel");
kernel.ensurePlatformKernelSchema();
const scopes = require("../src/security/network-scopes");

test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function rejectEvent(eventType, triggerName) {
  dbStore.getDb().exec(`CREATE TEMP TRIGGER ${triggerName} BEFORE INSERT ON platform_execution_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'synthetic platform event failure'); END`);
}

function dropTrigger(triggerName) {
  dbStore.getDb().exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
}

function createScope(name) {
  return scopes.create({ name, allowed_ips: ["192.0.2.10"], allowed_protocols: ["https"], allowed_ports: [443] }, "principal-1");
}

test("network-scope creation rolls back when its durable platform event cannot be recorded", () => {
  rejectEvent("network_scope.created", "reject_network_scope_create_event");
  assert.throws(() => createScope("audit_create_rollback"), /synthetic platform event failure/);
  dropTrigger("reject_network_scope_create_event");
  assert.equal(dbStore.getDb().prepare("SELECT COUNT(*) AS count FROM platform_network_scopes WHERE name = ?").get("audit_create_rollback").count, 0);
});

test("network-scope revision rolls back when its durable platform event cannot be recorded", () => {
  const created = createScope("audit_revision_rollback");
  rejectEvent("network_scope.revised", "reject_network_scope_revision_event");
  assert.throws(() => scopes.update(created.scope_id, { allowed_ips: ["192.0.2.11"], allowed_protocols: ["https"], allowed_ports: [443] }, "principal-1"), /synthetic platform event failure/);
  dropTrigger("reject_network_scope_revision_event");
  assert.equal(scopes.get(created.scope_id).revision, 1);
});

test("network-scope state change rolls back when its durable platform event cannot be recorded", () => {
  const created = createScope("audit_state_rollback");
  rejectEvent("network_scope.disabled", "reject_network_scope_state_event");
  assert.throws(() => scopes.setState(created.scope_id, "disabled", "principal-1"), /synthetic platform event failure/);
  dropTrigger("reject_network_scope_state_event");
  assert.equal(scopes.get(created.scope_id).state, "active");
});
