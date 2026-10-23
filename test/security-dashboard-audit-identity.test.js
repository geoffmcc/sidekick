"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { dashboardActor, createDashboardAuditEntry } = require("../src/dashboard/audit-identity");

test("cookie-authenticated dashboard audit uses the authenticated principal", () => {
  const req = {
    authPrincipal: { principal_id: "principal-human-17", principal_type: "human", display_name: "Geoff" },
    authUser: "Geoff",
    headers: { cookie: "sidekick_identity=session" },
    params: { key: "setting" },
    ip: "127.0.0.1",
  };
  const entry = createDashboardAuditEntry(req, "kv.updated", { value: "safe" }, null, "2026-10-22T12:00:00.000Z");
  assert.equal(dashboardActor(req), "principal-human-17");
  assert.equal(entry.user, "Geoff");
  assert.equal(entry.principal_id, "principal-human-17");
  assert.equal(entry.principal_type, "human");
});

test("service principal attribution is stable and does not leak credential material", () => {
  const credential = randomBytes(32).toString("base64url");
  const req = {
    authPrincipal: { principal_id: "principal-service-4", principal_type: "service", display_name: "Pack Manager" },
    headers: { authorization: ["Bearer", credential].join(" ") },
    params: {},
    ip: "10.0.0.4",
  };
  const serialized = JSON.stringify(createDashboardAuditEntry(req, "capability.upgrade", {}, null));
  assert.equal(dashboardActor(req), "principal-service-4");
  assert.match(serialized, /principal-service-4/);
  assert.equal(serialized.includes(credential), false);
});

test("untrusted Authorization header cannot override authenticated identity or create one", () => {
  const req = { headers: { authorization: "Basic YWRtaW46cGFzc3dvcmQ=" }, params: {} };
  assert.equal(dashboardActor(req), "anonymous");
  const entry = createDashboardAuditEntry(req, "read", {});
  assert.equal(entry.user, "anonymous");
  assert.equal(entry.principal_id, null);
  assert.doesNotMatch(JSON.stringify(entry), /password|admin/);
});

test("legacy authenticated username is retained when principal middleware is unavailable", () => {
  const req = { authUser: "legacy-user", params: {} };
  assert.equal(dashboardActor(req), "legacy-user");
  assert.equal(createDashboardAuditEntry(req, "read", {}).user, "legacy-user");
});
