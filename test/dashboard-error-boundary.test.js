"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { addCorrelationMiddleware, createDashboardErrorBoundary, publicError } = require("../src/dashboard/error-boundary");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-errors-"));
const logFile = path.join(tempDir, "dashboard-errors.jsonl");
const boundary = createDashboardErrorBoundary({ fs, logFile });

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

{
  const req = { method: "POST", headers: { "x-request-id": "request-42" }, route: { path: "/api/test" }, body: { password: "do-not-log" } };
  const res = response();
  addCorrelationMiddleware(req, res, () => {});
  boundary.respond(req, res, new Error("secret token /home/user/.env"), { status: 503, code: "service_unavailable", component: "test" });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    ok: false,
    error: "Dashboard service is temporarily unavailable.",
    code: "service_unavailable",
    correlation_id: "request-42",
  });
  assert.equal(res.headers["X-Correlation-ID"], "request-42");

  const diagnostic = JSON.parse(fs.readFileSync(logFile, "utf8"));
  assert.equal(diagnostic.message, "[REDACTED]");
  assert.equal(diagnostic.stack, "[REDACTED]");
  assert.equal(diagnostic.correlation_id, "request-42");
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret token|\.env|do-not-log|home\/user/);
}

{
  const req = { method: "GET", headers: { "x-request-id": "bad id with spaces" } };
  const res = response();
  addCorrelationMiddleware(req, res, () => {});
  assert.match(res.headers["X-Correlation-ID"], /^dash_[a-f0-9]{24}$/);
  assert.deepEqual(publicError(413), { status: 413, code: "payload_too_large", message: "Request payload is too large." });
}

{
  const req = { method: "GET", headers: { "x-request-id": "request-43" }, route: { path: "/api/hostile" } };
  const res = response();
  const error = Object.assign(new Error("SQL SELECT secret FROM users at /srv/sidekick/.env"), { status: 400 });
  boundary.respond(req, res, error, { status: 503, code: "service_unavailable", component: "hostile" });
  assert.equal(res.statusCode, 503, "explicit route status must not be replaced by an error property");
  assert.equal(res.body.error, "Dashboard service is temporarily unavailable.");
  assert.equal(res.body.correlation_id, "request-43");
  assert.doesNotMatch(JSON.stringify(res.body), /SQL|SELECT|secret|sidekick|\.env|srv/);
}

{
  const req = { method: "GET", headers: { "x-request-id": "request-44" }, route: { path: "/api/not-found" } };
  const res = response();
  boundary.respond(req, res, null, {
    status: 404,
    code: "not_found",
    publicMessage: "Incident not found",
    extra: { connector_id: "connector-1", ignored: "provider body" },
  });
  assert.deepEqual(res.body, {
    ok: false,
    error: "Incident not found",
    code: "not_found",
    correlation_id: "request-44",
    connector_id: "connector-1",
  });
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("Dashboard error boundary tests passed");
