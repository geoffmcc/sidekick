"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-blackbox-auth-"));
process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const blackbox = require("../src/blackbox");
const dispatcher = require("../src/tools/dispatcher");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");

const owner = identity.bootstrapOwner({ username: "blackbox_auth_owner", password: "synthetic sufficiently long password" });
const operator = require('./helpers/authorized-identity').createHumanUser(identity, { username: "blackbox_auth_operator", password: "synthetic sufficiently long password" });
identity.assignRole(operator.principal_id, "operator", owner.principal_id);
const auditor = require('./helpers/authorized-identity').createHumanUser(identity, { username: "blackbox_auth_auditor", password: "synthetic sufficiently long password" });
identity.assignRole(auditor.principal_id, "auditor", owner.principal_id);
const descriptor = getCanonicalRegistry().get("black_box");

test.after(() => {
  db.closeDatabase();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("Black Box evidence reads use the Dashboard blackbox.read permission", () => {
  for (const action of ["list", "get_incident", "list_sources", "get_source", "search", "export", "analyze", "compare", "storage_status"]) {
    assert.equal(dispatcher.requiredToolPermission(descriptor, { action }), "blackbox.read", `${action} reads sensitive Black Box state`);
  }
  assert.equal(dispatcher.requiredToolPermission(descriptor, { action: "delete" }), "tools.execute", "mutation keeps its ordinary execution grant in addition to the handler read gate");
});

test("operators cannot read or mutate evidence; auditors retain read-only access", async () => {
  const capture = await blackbox.captureIncident({ name: "synthetic authorization fixture", profile: "quick", include: ["system.identity"] });
  const operatorContext = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" } };
  const auditorContext = { authIdentity: { principal_id: auditor.principal_id, principal_type: "human" } };

  const deniedList = await dispatcher.dispatchTestTool({ descriptor, args: { action: "list_incidents" }, context: operatorContext });
  assert.equal(deniedList.isError, true);
  assert.equal(deniedList.code, "authorization_denied");
  const deniedDelete = await dispatcher.dispatchTestTool({ descriptor, args: { action: "delete", incident_id: capture.incident_id }, context: operatorContext });
  assert.equal(deniedDelete.isError, true);
  assert.equal(deniedDelete.code, "authorization_denied");

  const auditorRead = await dispatcher.dispatchTestTool({ descriptor, args: { action: "get_incident", incident_id: capture.incident_id }, context: auditorContext });
  assert.notEqual(auditorRead.isError, true, JSON.stringify(auditorRead));
  const auditorDelete = await dispatcher.dispatchTestTool({ descriptor, args: { action: "delete", incident_id: capture.incident_id }, context: auditorContext });
  assert.equal(auditorDelete.isError, true);
  assert.equal(auditorDelete.code, "authorization_denied", "read access does not grant mutation permission");
  assert.ok(blackbox.getIncident(capture.incident_id), "denied delete leaves the evidence intact");
});
