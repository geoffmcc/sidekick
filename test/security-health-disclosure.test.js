"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { projectMcpSessionHealth, projectStartupFailures } = require("../src/security/health-disclosure");

test("public health projection reports failed components without exception details", () => {
  const failures = {
    compute: "Cannot read secret from C:\\Users\\operator\\.config\\provider.json",
    browser: "connect ECONNREFUSED 10.20.30.40:9222",
  };
  const projected = projectStartupFailures(failures);
  assert.deepEqual(projected, { compute: "unavailable", browser: "unavailable" });
  assert.doesNotMatch(JSON.stringify(projected), /operator|provider\.json|10\.20\.30\.40|9222/);
});

test("authorized health diagnostics retain bounded startup error text", () => {
  const failures = { compute: "synthetic provider initialization failure" };
  assert.deepEqual(projectStartupFailures(failures, true), failures);
});

test("healthy public probes return an empty failure map", () => {
  assert.deepEqual(projectStartupFailures({}), {});
});

test("public health preserves counts but withholds MCP session identifiers and client metadata", () => {
  const snapshot = {
    sessions: 1,
    staleMappings: 0,
    sessionDetails: [{ id: "synthetic-session-id", userAgent: "synthetic-test", clientInfo: { name: "test-client" } }],
  };
  assert.deepEqual(projectMcpSessionHealth(snapshot), { sessions: 1, staleMappings: 0 });
  assert.doesNotMatch(JSON.stringify(projectMcpSessionHealth(snapshot)), /synthetic-session-id|synthetic-test|test-client/);
});

test("authorized health diagnostics retain only the supplied session detail snapshot", () => {
  const snapshot = { sessions: 1, staleMappings: 2, sessionDetails: [{ id: "synthetic-session-id" }] };
  assert.deepEqual(projectMcpSessionHealth(snapshot, true), snapshot);
  assert.deepEqual(projectMcpSessionHealth({ sessions: 1 }, true), { sessions: 1, staleMappings: 0, sessionDetails: [] });
});

test("both public Core probes use the redacted projection and gate details on operator authority", () => {
  const indexSource = fs.readFileSync(require.resolve("../src/index.js"), "utf8");
  const projections = indexSource.match(/failures:\s*projectStartupFailures\(startupFailures, includeDetails\)/g) || [];
  const diagnosticGrants = indexSource.match(/permission:\s*"system\.configure"/g) || [];
  assert.equal(projections.length, 2, "health and readiness routes must both redact raw failure messages");
  assert.equal(diagnosticGrants.length, 2, "each route must authorize detailed diagnostics independently");
  assert.match(indexSource, /projectMcpSessionHealth\(sessionSnapshot, includeDetails\)/,
    "health must project the public snapshot and gate MCP session identifiers on operator authority");
});
