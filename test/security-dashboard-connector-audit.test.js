"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-connector-audit-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
delete require.cache[require.resolve("../src/platform/kernel")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const kernel = require("../src/platform/kernel");
kernel.ensurePlatformKernelSchema();
const { registerConnectorRoutes } = require("../src/dashboard/connectors-routes");

test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function createHarness({ failRequestAudit = false, failCompletionAudit = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = {
    get: (route, handler) => handlers.set(`GET ${route}`, handler),
    post: (route, handler) => handlers.set(`POST ${route}`, handler),
  };
  const platformKernel = {
    registerConnector: input => { calls.push(["register", input]); return { connector_id: "connector-1", name: input.name, type: input.type }; },
    configureConnector: (id, input) => { calls.push(["configure", id, input]); return { connector_id: id, secret_ref: input.secret_ref }; },
    transitionConnector: (id, state, input) => { calls.push(["transition", id, state, input]); return { connector_id: id, state }; },
  };
  registerConnectorRoutes({
    app,
    platformKernel,
    probeConnector: async () => ({ ok: true }),
    authenticatedUser: () => "principal-1",
    requireIdentityPermission: () => true,
    startDashboardExecution: () => ({ execution_id: "execution-1" }),
    finishDashboardExecution: () => {},
    auditLog: (_req, action) => {
      if (failRequestAudit && action.endsWith(".requested")) throw new Error("request audit unavailable");
      if (failCompletionAudit && !action.endsWith(".requested")) throw new Error("completion audit unavailable");
    },
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });
  return { handlers, calls };
}

function invoke(handler, request = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handler({ body: {}, params: {}, query: {}, ...request }, res);
  return res;
}

test("connector mutation request-audit failures prevent all platform mutations", () => {
  const { handlers, calls } = createHarness({ failRequestAudit: true });
  const register = invoke(handlers.get("POST /api/connectors"), { body: { name: "test", type: "http" } });
  const configure = invoke(handlers.get("POST /api/connectors/:connectorId/configure"), { params: { connectorId: "connector-1" }, body: { config: { region: "test" } } });
  const transition = invoke(handlers.get("POST /api/connectors/:connectorId/:action"), { params: { connectorId: "connector-1", action: "enable" } });
  for (const response of [register, configure, transition]) {
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, "audit_unavailable");
  }
  assert.deepEqual(calls, []);
});

test("connector configure attributes the actor and reports a failed completion sink", () => {
  const { handlers, calls } = createHarness({ failCompletionAudit: true });
  const response = invoke(handlers.get("POST /api/connectors/:connectorId/configure"), {
    params: { connectorId: "connector-1" }, body: { config: { region: "test" } },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.equal(calls[0][0], "configure");
  assert.equal(calls[0][2].actor_id, "principal-1");
});

test("platform connector events retain the authenticated dashboard actor", () => {
  const registered = kernel.registerConnector({ name: "actor attribution", type: "http", source: "dashboard", actor_id: "principal-1" });
  const configured = kernel.configureConnector(registered.connector_id, { source: "dashboard", actor_id: "principal-1", config: { region: "test" } });
  const events = dbStore.getDb().prepare("SELECT event_type, actor_id FROM platform_execution_events WHERE subject_type = 'connector' AND subject_id = ? ORDER BY rowid").all(configured.connector_id);
  assert.deepEqual(events.map(event => event.event_type), ["connector.registered", "connector.state_changed", "connector.configured"]);
  assert.deepEqual(events.map(event => event.actor_id), ["principal-1", "principal-1", "principal-1"]);
});
