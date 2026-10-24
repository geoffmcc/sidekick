const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { registerSyncRoutes } = require("../src/dashboard/sync-routes");
const { registerEventRoutes } = require("../src/dashboard/event-routes");
const { registerLogsRoute } = require("../src/dashboard/logs-route");
const { registerMemoryReadRoutes } = require("../src/dashboard/memory-read-routes");
const { registerConnectorRoutes } = require("../src/dashboard/connectors-routes");
const { registerQuickActionsRoute } = require("../src/dashboard/quick-actions-route");
const { registerScopeSnapshotRoutes } = require("../src/dashboard/scope-snapshot-routes");
const { registerWebhookRoute } = require("../src/dashboard/webhook-route");
const { registerNetworkScopeRoutes } = require("../src/dashboard/network-scope-routes");
const { registerComputeReadRoutes } = require("../src/dashboard/compute-read-routes");
const { registerKvRoutes } = require("../src/dashboard/kv-routes");
const { registerDashboardConfigRoute } = require("../src/dashboard/config-route");
const { registerSystemRoutes } = require("../src/dashboard/system-routes");
const { registerStatsToolsRoutes } = require("../src/dashboard/stats-tools-routes");
const { registerSummaryRoute } = require("../src/dashboard/summary-route");
const { registerDoctorRoute } = require("../src/dashboard/doctor-route");
const { registerApprovalRoutes } = require("../src/dashboard/approval-routes");
const { registerPredictRoutes } = require("../src/dashboard/predict-routes");
const { registerHandoffReadRoutes } = require("../src/dashboard/handoff-read-routes");
const { registerBlackboxRoutes } = require("../src/dashboard/blackbox-routes");
const { registerPerformanceRoutes } = require("../src/dashboard/performance-routes");
const { registerDatabaseRoutes } = require("../src/dashboard/database-routes");

function makeHarness(register, overrides = {}) {
  const handlers = new Map();
  const permissions = [];
  let sideEffects = 0;
  const app = Object.fromEntries(["get", "post", "put", "patch", "delete"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  const requireIdentityPermission = (_req, res, permission) => {
    permissions.push(permission);
    res.status(403).json({ code: "forbidden" });
    return false;
  };
  const dbStore = new Proxy({}, { get: () => () => { sideEffects++; throw new Error("must not execute when denied"); } });
  const platformKernel = new Proxy({}, { get: () => () => { sideEffects++; throw new Error("must not execute when denied"); } });
  register({
    app, dbStore, platformKernel,
    authenticatedUser: () => "viewer",
    recordIdentityAudit: () => {},
    requireIdentityPermission,
    projectAccess: { hasGlobalProjectAccess: () => false, hasGlobalMemoryAccess: () => false, hasProjectAccess: () => false, listAccessibleProjects: () => [] },
    memoryCategory: () => "fact",
    auditLog: () => { sideEffects++; },
    errorResponse: () => { sideEffects++; },
    ...overrides,
  });
  return { handlers, permissions, get sideEffects() { return sideEffects; } };
}

function invoke(handler, request = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
  };
  handler({ query: {}, body: {}, params: {}, authPrincipal: { principal_id: "viewer" }, ...request }, res);
  return res;
}

test("approval routes fail closed without principal or authorization service", async () => {
  const handlers = new Map();
  let reads = 0;
  let mutations = 0;
  const app = Object.fromEntries(["get", "post"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  const dependencies = {
    app,
    listApprovals: () => { reads++; return []; },
    renderContinuationApprovalPreview: () => { reads++; return { ok: true }; },
    authenticatedUser: () => "legacy-user",
    auditLog: () => {}, logError: () => {},
    resolveApproval: async () => { mutations++; return { content: [{ type: "text", text: "approved" }] }; },
    errorResponse: () => assert.fail("unexpected error response"),
  };
  registerApprovalRoutes(dependencies);
  const withoutAuthorization = invoke(handlers.get("GET /api/approvals"));
  assert.equal(withoutAuthorization.statusCode, 503);
  assert.equal(withoutAuthorization.body.code, "authorization_unavailable");
  const previewWithoutAuthorization = invoke(handlers.get("GET /api/approvals/:id/preview"), { params: { id: "approval-1" } });
  assert.equal(previewWithoutAuthorization.statusCode, 503);
  const missingPrincipal = invoke(handlers.get("GET /api/approvals"), { authPrincipal: null });
  assert.equal(missingPrincipal.statusCode, 401);
  const denied = await invoke(handlers.get("POST /api/approvals/:id/approve"), { params: { id: "approval-1" } });
  assert.equal(denied.statusCode, 503);
  assert.equal(reads, 0, "approval data must not be read without explicit authorization");
  assert.equal(mutations, 0, "approval decisions must not execute without explicit authorization");

  const deniedHandlers = new Map();
  registerApprovalRoutes({ ...dependencies, app: { get: (route, handler) => deniedHandlers.set(`GET ${route}`, handler), post: (route, handler) => deniedHandlers.set(`POST ${route}`, handler) }, requireIdentityPermission: (_req, res) => { res.status(403).json({ code: "forbidden" }); return false; } });
  const deniedByPolicy = await invoke(deniedHandlers.get("POST /api/approvals/:id/approve"), { params: { id: "approval-1" } });
  assert.equal(deniedByPolicy.statusCode, 403);
  assert.equal(mutations, 0, "denied approval must not resolve");

  const authorizedHandlers = new Map();
  const permissionCalls = [];
  registerApprovalRoutes({ ...dependencies, app: { get: (route, handler) => authorizedHandlers.set(`GET ${route}`, handler), post: (route, handler) => authorizedHandlers.set(`POST ${route}`, handler) }, requireIdentityPermission: (_req, _res, permission) => { permissionCalls.push(permission); return true; } });
  const authorizedList = invoke(authorizedHandlers.get("GET /api/approvals"));
  assert.equal(authorizedList.statusCode, 200);
  assert.deepEqual(authorizedList.body.approvals, []);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await authorizedHandlers.get("POST /api/approvals/:id/approve")({ params: { id: "approval-1" }, query: {}, authPrincipal: { principal_id: "viewer" } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(mutations, 1, "an explicitly authorized approval remains usable");
  assert.deepEqual(permissionCalls, ["approvals.read", "approvals.grant"]);
});

test("prediction reads require a grant and stay within active project access", () => {
  const handlers = new Map();
  const permissions = [];
  const listCalls = [];
  let evidenceReads = 0;
  const principal = { principal_id: "viewer", scopes: null };
  const predictionA = { id: "pred-a", project: "project-a", subject: "A only" };
  const predictionB = { id: "pred-b", project: "project-b", subject: "B secret" };
  const app = Object.fromEntries(["get", "post"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  let allowPermission = true;
  const projectAccess = {
    hasGlobalProjectAccess: () => false,
    listAccessibleProjectsForPermission: (_principal, permission) => { assert.equal(permission, "predictions.read"); return [{ project_id: "project-a" }]; },
    hasProjectPermission: (_principal, project, permission, access) => project === "project-a" && permission === "predictions.read" && access === "read",
  };
  const predictEngine = {
    listPredictions: filters => { listCalls.push(filters); return [predictionA]; },
    getPrediction: id => id === predictionA.id ? predictionA : id === predictionB.id ? predictionB : null,
    getPredictionEvidence: () => { evidenceReads++; return []; },
    getPredictionFeedback: () => { evidenceReads++; return []; },
    engineStatus: () => ({ status: "ready" }),
  };
  registerPredictRoutes({
    app, predictEngine, projectAccess,
    requireIdentityPermission: (_req, res, permission) => { permissions.push(permission); if (permission === "predictions.read" && allowPermission) return true; res.status(403).json({ code: "forbidden" }); return false; },
    governedDashboardMutation: () => {}, errorResponse: () => assert.fail("unexpected error response"),
  });

  allowPermission = false;
  assert.equal(invoke(handlers.get("GET /api/predict"), { authPrincipal: principal }).statusCode, 403);
  assert.equal(listCalls.length, 0, "a denied grant must prevent prediction reads");
  allowPermission = true;
  const list = invoke(handlers.get("GET /api/predict"), { authPrincipal: principal });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(listCalls[0].projects, ["project-a"], "unfiltered lists are constrained to accessible projects");
  const crossProjectFilter = invoke(handlers.get("GET /api/predict"), { authPrincipal: principal, query: { project: "project-b" } });
  assert.equal(crossProjectFilter.statusCode, 404);
  const crossProjectDetail = invoke(handlers.get("GET /api/predict/:id"), { authPrincipal: principal, params: { id: "pred-b" } });
  assert.equal(crossProjectDetail.statusCode, 404);
  assert.equal(evidenceReads, 0, "cross-project evidence and feedback must not be read");
  const allowedDetail = invoke(handlers.get("GET /api/predict/:id"), { authPrincipal: principal, params: { id: "pred-a" } });
  assert.equal(allowedDetail.statusCode, 200);
  assert.equal(allowedDetail.body.prediction.subject, "A only");
  assert.equal(evidenceReads, 2);
  assert.equal(invoke(handlers.get("GET /api/predict/status"), { authPrincipal: principal }).statusCode, 403, "operational engine status requires the operations read grant");
  assert.ok(permissions.includes("predictions.read"));
  assert.ok(permissions.includes("dashboard.operations.read"));
});

test("direct Dashboard catalogs and reconciliation routes retain their explicit grants", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/dashboard.js"), "utf8");
  const routes = [
    ["/api/llm", "compute.nodes.read"],
    ["/api/tool-policy", "dashboard.catalog.read"],
    ["/api/tool-categories", "dashboard.catalog.read"],
    ["/api/evolve", "dashboard.operations.read"],
    ["/api/reconciliations", "approvals.read"],
    ["/api/reconciliations/:taskId/resolve", "approvals.grant"],
    ["/api/knowledge", "dashboard.catalog.read"],
    ["/api/procedures", "dashboard.catalog.read"],
  ];
  for (const [route, permission] of routes) {
    const routeSource = route === "/api/knowledge"
      ? fs.readFileSync(path.join(__dirname, "../src/dashboard/knowledge-route.js"), "utf8")
      : source;
    const candidates = [`app.get("${route}"`, `app.post("${route}"`];
    const start = candidates.map(candidate => routeSource.indexOf(candidate)).find(index => index >= 0);
    assert.notEqual(start, undefined, `route exists: ${route}`);
    const routeHead = routeSource.slice(start, start + 600);
    assert.ok(routeHead.includes(`requireIdentityPermission(req, res, "${permission}")`), `${route} enforces ${permission}`);
  }
});

test("system and stats read routes require permission before system or log access", () => {
  const system = makeHarness(registerSystemRoutes, {
    systemSnapshot: () => { throw new Error("system snapshot must not run"); },
    systemctlStatus: () => { throw new Error("systemctl must not run"); },
    getJsonFromLocalService: () => { throw new Error("metrics probe must not run"); },
    http: { get: () => { throw new Error("metrics HTTP probe must not run"); } },
  });
  for (const route of ["GET /api/system", "GET /api/services", "GET /api/metrics/status"]) {
    assert.equal(invoke(system.handlers.get(route)).statusCode, 403, route);
  }
  assert.deepEqual(system.permissions, ["dashboard.operations.read", "dashboard.operations.read", "dashboard.operations.read"]);
  assert.equal(system.sideEffects, 0);
  assert.equal(invoke(system.handlers.get("GET /api/system"), { authPrincipal: null }).statusCode, 403, "missing principal must still be evaluated and denied");
  assert.equal(system.permissions.at(-1), "dashboard.operations.read");

  const stats = makeHarness(registerStatsToolsRoutes, {
    getToolDefsForSource: () => { throw new Error("tool catalog must not be read"); },
  });
  assert.equal(invoke(stats.handlers.get("GET /api/stats")).statusCode, 403);
  assert.equal(invoke(stats.handlers.get("GET /api/tools")).statusCode, 403);
  assert.deepEqual(stats.permissions, ["audit.read", "dashboard.catalog.read"]);
  assert.equal(stats.sideEffects, 0);
  assert.equal(invoke(stats.handlers.get("GET /api/stats"), { authPrincipal: null }).statusCode, 403, "missing principal must not skip audit authorization");
  assert.equal(stats.permissions.at(-1), "audit.read");
});

test("KV mutation fails closed when the admin authorization service is unavailable", () => {
  const harness = makeHarness(registerKvRoutes, {
    safeString: String,
    summarizeValue: String,
    inferNamespace: () => "test",
    valueSize: () => 0,
    valueType: () => "test",
    requireIdentityAdministrator: undefined,
  });
  for (const [route, invokeHandler] of [
    ["PUT /api/kv/:key", handler => invoke(handler, { params: { key: "x" } })],
    ["DELETE /api/kv/:key", handler => invoke(handler, { params: { key: "x" } })],
  ]) {
    const response = invokeHandler(harness.handlers.get(route));
    assert.equal(response.statusCode, 503, route);
    assert.equal(response.body.code, "authorization_unavailable");
  }
  assert.equal(harness.sideEffects, 0);
});

test("dashboard summary requires operations read before collecting sensitive status", () => {
  let summaryRuns = 0;
  const summary = makeHarness(registerSummaryRoute, {
    handler: (_req, res) => { summaryRuns++; res.json({ ok: true }); },
  });
  assert.equal(invoke(summary.handlers.get("GET /api/dashboard-summary")).statusCode, 403);
  assert.deepEqual(summary.permissions, ["dashboard.operations.read"]);
  assert.equal(summaryRuns, 0);
  assert.equal(summary.sideEffects, 0);
});

test("doctor diagnostics require operations read before running system checks", () => {
  let probes = 0;
  const denied = makeHarness(registerDoctorRoute, {
    runDoctor: () => { probes++; throw new Error("diagnostics must not run when denied"); },
    formatDoctorText: () => "",
    createSupportBundle: () => ({}),
  });
  assert.equal(invoke(denied.handlers.get("GET /api/doctor")).statusCode, 403);
  assert.deepEqual(denied.permissions, ["dashboard.operations.read"]);
  assert.equal(probes, 0);

  const allowed = makeHarness(registerDoctorRoute, {
    requireIdentityPermission: () => true,
    runDoctor: () => { probes++; return { ok: true }; },
    createSupportBundle: ({ report }) => ({ doctor: report }),
    formatDoctorText: report => JSON.stringify(report),
  });
  const response = invoke(allowed.handlers.get("GET /api/doctor"));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { doctor: { ok: true } });
  assert.equal(probes, 1);
});

test("all direct sync routes require explicit read or manage permission before storage access", () => {
  const harness = makeHarness(registerSyncRoutes);
  for (const route of [
    "GET /api/sync/identity", "POST /api/sync/identity", "GET /api/sync/export",
    "POST /api/sync/import", "GET /api/sync/diff",
  ]) {
    const response = invoke(harness.handlers.get(route));
    assert.equal(response.statusCode, 403, route);
  }
  assert.deepEqual(harness.permissions, ["sync.read", "sync.manage", "sync.read", "sync.manage", "sync.read"]);
  assert.equal(harness.sideEffects, 0, "denied requests must not reach storage, audit mutation, or error handlers");
});

test("runtime configuration requires admin permission and redacts credential-bearing names", () => {
  const env = {
    SIDEKICK_AGENT_MODEL: "model-x",
    SIDEKICK_POSTGRES_URL: "postgres://user:synthetic-secret@db.invalid/sidekick",
    SIDEKICK_CUSTOM_CREDENTIAL: "synthetic-credential",
    SIDEKICK_AGENT_PROXY_KEY: "synthetic-proxy-key",
    GROQ_API_KEY: "synthetic-key",
    OLLAMA_URL: "http://localhost:11434",
    OTHER_SECRET: "not-included",
  };
  const denied = makeHarness(registerDashboardConfigRoute, { env });
  const deniedResponse = invoke(denied.handlers.get("GET /api/config"));
  assert.equal(deniedResponse.statusCode, 403);
  assert.deepEqual(denied.permissions, ["dashboard.config.read"]);
  assert.equal(denied.sideEffects, 0);

  const allowed = makeHarness(registerDashboardConfigRoute, {
    env,
    requireIdentityPermission: () => true,
  });
  const response = invoke(allowed.handlers.get("GET /api/config"));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.config, {
    SIDEKICK_AGENT_MODEL: "model-x",
    SIDEKICK_POSTGRES_URL: "***redacted***",
    SIDEKICK_CUSTOM_CREDENTIAL: "***redacted***",
    SIDEKICK_AGENT_PROXY_KEY: "***redacted***",
    GROQ_API_KEY: "***redacted***",
    OLLAMA_URL: "***redacted***",
  });
  assert.doesNotMatch(JSON.stringify(response.body), /synthetic-secret|synthetic-credential|synthetic-key|synthetic-proxy-key/);
});

test("sync export and import enforce memory action permission and project membership", () => {
  const calls = [];
  const projectAccess = {
    hasGlobalMemoryAccess: (_principalId, access) => access === "write" && false,
    hasProjectAccess: (_principalId, project, access) => project === "allowed_project" && access === "read",
  };
  const harness = makeHarness(registerSyncRoutes, {
    requireIdentityPermission: () => true,
    projectAccess,
    dbStore: {
      exportForSync: options => { calls.push(["export", options]); return { count: 1, memories: [] }; },
      importFromSync: (_data, options) => { calls.push(["import", options]); options.audit({ imported: 0, updated: 0, skipped: 0, conflicts: 0 }); return { imported: 0, conflicts: 0, skipped: 0 }; },
    },
  });

  const unscopedExport = invoke(harness.handlers.get("GET /api/sync/export"));
  assert.equal(unscopedExport.statusCode, 400);
  const deniedExport = invoke(harness.handlers.get("GET /api/sync/export"), { query: { project: "other_project" } });
  assert.equal(deniedExport.statusCode, 403);
  const allowedExport = invoke(harness.handlers.get("GET /api/sync/export"), { query: { project: "allowed_project" } });
  assert.equal(allowedExport.statusCode, 200);
  assert.deepEqual(calls[0], ["export", { project: "allowed_project" }]);

  const unscopedImport = invoke(harness.handlers.get("POST /api/sync/import"), { body: { data: { memories: [] } } });
  assert.equal(unscopedImport.statusCode, 400);
  const deniedImport = invoke(harness.handlers.get("POST /api/sync/import"), { body: { project: "other_project", data: { memories: [] } } });
  assert.equal(deniedImport.statusCode, 403);
  assert.equal(calls.length, 1, "denied export/import must not touch memory storage");
});

test("sync import constrains writes to its authorized project and diff requires global read", () => {
  const calls = [];
  const harness = makeHarness(registerSyncRoutes, {
    requireIdentityPermission: () => true,
    projectAccess: {
      hasGlobalMemoryAccess: () => false,
      hasProjectAccess: (_principalId, project, access) => project === "allowed_project" && access === "write",
    },
    dbStore: {
      importFromSync: (_data, options) => { calls.push(options); options.audit({ imported: 0, updated: 0, skipped: 2, conflicts: 0 }); return { imported: 0, conflicts: 0, skipped: 2 }; },
      getSyncDiff: () => { throw new Error("must not expose unscoped sync diff"); },
    },
  });
  const imported = invoke(harness.handlers.get("POST /api/sync/import"), {
    body: { project: "allowed_project", data: { memories: [{ project: "allowed_project" }, { project: "other_project" }] } },
  });
  assert.equal(imported.statusCode, 200);
  assert.equal(calls[0].projectScope, "allowed_project");
  assert.equal(invoke(harness.handlers.get("GET /api/sync/diff"), { query: { since: "2026-01-01" } }).statusCode, 400);
});

test("Dashboard sync diff accepts a granted project and passes the filter to storage", () => {
  let options;
  const harness = makeHarness(registerSyncRoutes, {
    requireIdentityPermission: () => true,
    projectAccess: {
      hasGlobalMemoryAccess: () => false,
      hasProjectAccess: (_principalId, project, access) => project === "allowed_project" && access === "read",
    },
    dbStore: { getSyncDiff: (_since, value) => { options = value; return { changes: [] }; } },
  });
  const response = invoke(harness.handlers.get("GET /api/sync/diff"), {
    query: { project: "allowed_project", since: "2026-01-01" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(options, { project: "allowed_project" });
});

test("direct event listing and mutation routes require explicit permissions", () => {
  const harness = makeHarness(registerEventRoutes);
  for (const route of [
    "GET /api/event-deliveries", "POST /api/event-subscriptions",
    "POST /api/event-subscriptions/:subscriptionId/:action",
    "POST /api/event-deliveries/:deliveryId/requeue",
  ]) {
    const response = invoke(harness.handlers.get(route));
    assert.equal(response.statusCode, 403, route);
  }
  assert.deepEqual(harness.permissions, ["events.read", "events.manage", "events.manage", "events.manage"]);
  assert.equal(harness.sideEffects, 0, "denied requests must not reach the platform kernel or audit mutation");
});

test("all direct connector reads and mutations require explicit permissions before platform access", async () => {
  const handlers = new Map();
  const permissions = [];
  let calls = 0;
  const app = Object.fromEntries(["get", "post"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  const platformKernel = new Proxy({}, { get: () => () => { calls++; throw new Error("must not access connectors when denied"); } });
  const requireIdentityPermission = (_req, res, permission) => {
    permissions.push(permission);
    res.status(403).json({ code: "forbidden" });
    return false;
  };
  registerConnectorRoutes({
    app, platformKernel, probeConnector: async () => { calls++; }, authenticatedUser: () => "viewer",
    requireIdentityPermission, startDashboardExecution: () => { calls++; }, finishDashboardExecution: () => { calls++; },
    auditLog: () => { calls++; }, errorResponse: () => { calls++; },
  });
  for (const route of [
    "GET /api/connectors", "GET /api/connectors/:connectorId", "GET /api/connectors/:connectorId/health", "GET /api/connectors/:connectorId/events",
    "POST /api/connectors", "POST /api/connectors/:connectorId/configure", "POST /api/connectors/:connectorId/:action",
  ]) {
    const method = route.split(" ")[0];
    const response = await invoke(handlers.get(route), { params: { connectorId: "connector-test", action: "enable" } });
    assert.equal(response.statusCode, 403, route);
    assert.equal(method, route.split(" ")[0]);
  }
  assert.deepEqual(permissions, ["connectors.read", "connectors.read", "connectors.read", "connectors.read", "connectors.manage", "connectors.manage", "connectors.manage"]);
  assert.equal(calls, 0, "denied connector requests must not call the platform, probe, execution or audit helpers");
});

test("quick actions require read/manage permissions before execution, logs, or service calls", async () => {
  const handlers = new Map();
  const permissions = [];
  let calls = 0;
  const app = {
    get: (route, handler) => handlers.set(route, handler),
    post: (route, handler) => handlers.set(route, handler),
  };
  registerQuickActionsRoute({
    app, requireIdentityPermission: (_req, res, permission) => { permissions.push(permission); res.status(403).json({ code: "forbidden" }); return false; },
    startDashboardExecution: () => { calls++; }, finishDashboardExecution: () => { calls++; }, systemctlStatus: () => { calls++; },
    systemSnapshot: () => { calls++; }, dbStore: { readToolLogs: () => { calls++; return []; } }, auditLog: () => { calls++; },
    callDashboardTool: async () => { calls++; return {}; }, dashboardExecutionMetadata: () => { calls++; }, authenticatedUser: () => "viewer",
    logError: () => { calls++; }, fs: { existsSync: () => { calls++; return false; }, readFileSync: () => { calls++; return "{}"; } },
    path: { join: (...parts) => parts.join("/") }, rootDir: "root", errorResponse: () => { calls++; },
  });
  for (const action of ["health-check", "recent-failures", "deployment", "service-logs", "restart-agent"]) {
    const response = await invoke(handlers.get("/api/quick-actions/:action"), { params: { action }, body: { service: "sidekick-mcp" } });
    assert.equal(response.statusCode, 403, action);
  }
  assert.deepEqual(permissions, ["dashboard.operations.read", "dashboard.operations.read", "dashboard.operations.read", "dashboard.operations.read", "dashboard.operations.manage"]);
  assert.equal(calls, 0, "denied operations must stop before execution, system, log, or tool calls");
});

test("scope snapshots require scope permission and active project membership", () => {
  const handlers = new Map();
  const calls = [];
  const app = Object.fromEntries(["get", "post"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  const platformKernel = {
    getProject: projectId => ({ project_id: projectId, state: "active" }),
    getScopeSnapshot: id => ({ snapshot_id: id, project_id: "restricted_project", state: "active" }),
    listScopeSnapshots: () => { calls.push("list"); return []; },
    createScopeSnapshot: () => { calls.push("create"); return {}; },
    evaluateScope: () => { calls.push("evaluate"); return {}; },
  };
  registerScopeSnapshotRoutes({
    app, platformKernel, projectAccess: { hasProjectAccess: () => false }, authenticatedUser: () => "viewer",
    requireIdentityPermission: () => true, auditLog: () => calls.push("audit"), errorResponse: () => calls.push("error"),
  });
  const listing = invoke(handlers.get("GET /api/scope-snapshots"), { query: { project_id: "restricted_project" } });
  assert.equal(listing.statusCode, 404);
  assert.equal(invoke(handlers.get("GET /api/scope-snapshots"), { query: {} }).statusCode, 400);
  assert.equal(invoke(handlers.get("POST /api/scope-snapshots"), { body: { project_id: "restricted_project" } }).statusCode, 404);
  assert.equal(invoke(handlers.get("POST /api/scope-guard/evaluate"), { body: { snapshot_id: "restricted_snapshot" } }).statusCode, 404);
  assert.deepEqual(calls, [], "out-of-project requests must not list, create, evaluate, or audit scope records");
});

test("webhook intake requires an explicit grant and records no payload in the audit event", () => {
  const handlers = new Map();
  const app = { post: (route, handler) => handlers.set(route, handler) };
  let stored;
  let audit;
  let permissionCalls = 0;
  let writes = 0;
  const dbStore = {
    loadDocument: () => [],
    setDocument: (_name, value) => { writes++; stored = value; },
  };
  registerWebhookRoute({
    app, dbStore,
    requireIdentityPermission: (_req, res, permission) => { permissionCalls++; assert.equal(permission, "webhooks.receive"); res.status(403).json({ code: "forbidden" }); return false; },
    auditLog: (...args) => { audit = args; }, errorResponse: () => assert.fail("no error expected"),
  });
  const denied = invoke(handlers.get("/api/webhook/:source"), { params: { source: "synthetic" }, body: { token: "SYNTHETIC_SECRET_123" } });
  assert.equal(denied.statusCode, 403);
  assert.equal(permissionCalls, 1);
  assert.equal(writes, 0);

  registerWebhookRoute({
    app, dbStore, requireIdentityPermission: () => true,
    auditLog: (...args) => { audit = args; }, errorResponse: () => assert.fail("no error expected"),
  });
  const accepted = invoke(handlers.get("/api/webhook/:source"), { params: { source: "synthetic" }, body: { token: "SYNTHETIC_SECRET_123" } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(writes, 1);
  assert.equal(stored[0].payload.token, "SYNTHETIC_SECRET_123");
  assert.equal(audit[1], "webhook.received");
  assert.equal(JSON.stringify(audit[2]).includes("SYNTHETIC_SECRET_123"), false, "audit metadata must not copy webhook payload content");
  const invalidSource = invoke(handlers.get("/api/webhook/:source"), { params: { source: "../bad" }, body: { ok: true } });
  assert.equal(invalidSource.statusCode, 400);
  const invalidPayload = invoke(handlers.get("/api/webhook/:source"), { params: { source: "valid" }, body: ["not", "an", "object"] });
  assert.equal(invalidPayload.statusCode, 400);
  const oversizedPayload = invoke(handlers.get("/api/webhook/:source"), { params: { source: "valid" }, body: { data: "x".repeat(256 * 1024) } });
  assert.equal(oversizedPayload.statusCode, 413);
  assert.equal(oversizedPayload.body.code, "payload_too_large");
  assert.equal(writes, 1, "oversized webhook payloads must not be persisted");
});

test("network scope reads and mutations require dedicated permissions before access", () => {
  const handlers = new Map();
  const permissions = [];
  let auditCalls = 0;
  const app = Object.fromEntries(["get", "post", "put"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  registerNetworkScopeRoutes({
    app, authenticatedUser: () => "viewer",
    requireIdentityPermission: (_req, res, permission) => { permissions.push(permission); res.status(403).json({ code: "forbidden" }); return false; },
    auditLog: () => { auditCalls++; }, logError: () => { auditCalls++; }, errorResponse: () => { auditCalls++; },
  });
  for (const route of [
    "GET /api/network-scopes", "GET /api/network-scopes/:scopeId",
    "POST /api/network-scopes/validate", "POST /api/network-scopes", "PUT /api/network-scopes/:scopeId",
    "POST /api/network-scopes/:scopeId/state", "POST /api/network-scopes/diagnose",
  ]) {
    const method = route.split(" ")[0];
    const response = invoke(handlers.get(route), { params: { scopeId: "restricted" } });
    assert.equal(response.statusCode, 403, route);
    assert.ok(["GET", "POST", "PUT"].includes(method));
  }
  assert.deepEqual(permissions, ["network_scopes.read", "network_scopes.read", "network_scopes.manage", "network_scopes.manage", "network_scopes.manage", "network_scopes.manage", "network_scopes.manage"]);
  assert.equal(auditCalls, 0, "denied scope operations must not audit or call downstream handlers");
});

test("direct Compute reads require explicit grants before touching Compute services", () => {
  const handlers = new Map();
  const permissions = [];
  let calls = 0;
  const app = { get: (route, handler) => handlers.set(route, handler) };
  const compute = new Proxy({}, { get: () => () => { calls++; throw new Error("must not read Compute when denied"); } });
  registerComputeReadRoutes({
    app, compute, computeInstallInfo: () => { calls++; }, projectAccess: {}, platformKernel: {},
    requireIdentityPermission: (_req, res, permission) => { permissions.push(permission); res.status(403).json({ code: "forbidden" }); return false; },
    errorResponse: () => { calls++; },
  });
  for (const route of ["/api/compute", "/api/compute/workers", "/api/compute/jobs", "/api/compute/jobs/:jobId", "/api/compute/install"]) {
    assert.equal(invoke(handlers.get(route), { params: { jobId: "job-secret" } }).statusCode, 403, route);
  }
  assert.deepEqual(permissions, ["compute.nodes.read", "compute.nodes.read", "compute.jobs.read", "compute.jobs.read", "compute.nodes.read"]);
  assert.equal(calls, 0);
});

test("Compute jobs require project scope and filter details, attempts, artifacts, and stats by access", () => {
  const handlers = new Map();
  const calls = [];
  const app = { get: (route, handler) => handlers.set(route, handler) };
  const compute = {
    initialize: () => calls.push("initialize"),
    jobManager: {
      listJobs: args => { calls.push(["listJobs", args]); return []; },
      getJobStats: args => { calls.push(["getJobStats", args]); return {}; },
      getJob: id => { calls.push(["getJob", id]); return { jobId: id, project: "restricted_project" }; },
      listAttempts: id => { calls.push(["listAttempts", id]); return []; },
      listArtifacts: id => { calls.push(["listArtifacts", id]); return []; },
    },
  };
  registerComputeReadRoutes({
    app, compute, computeInstallInfo: () => ({}), requireIdentityPermission: () => true,
    projectAccess: {
      hasGlobalProjectAccess: () => false,
      hasProjectAccess: (_principalId, project) => project === "allowed_project",
    },
    platformKernel: { getProject: project_id => ({ project_id, state: "active" }) },
    errorResponse: (_req, res, error, options) => res.status(options.status).json({ code: options.code }),
  });
  const missingScope = invoke(handlers.get("/api/compute/jobs"));
  assert.equal(missingScope.statusCode, 400);
  assert.deepEqual(calls, []);
  const crossProject = invoke(handlers.get("/api/compute/jobs"), { query: { project: "restricted_project" } });
  assert.equal(crossProject.statusCode, 404);
  assert.deepEqual(calls, []);
  const allowed = invoke(handlers.get("/api/compute/jobs"), { query: { project: "allowed_project" } });
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(calls.filter(call => Array.isArray(call)).map(call => call[1]), [{ status: undefined, jobType: undefined, project: "allowed_project", workerId: undefined, capability: undefined, limit: 50 }, { project: "allowed_project" }]);
  calls.length = 0;
  const detail = invoke(handlers.get("/api/compute/jobs/:jobId"), { params: { jobId: "job-secret" } });
  assert.equal(detail.statusCode, 404);
  assert.deepEqual(calls, ["initialize", ["getJob", "job-secret"]], "inaccessible job must not expose attempts or artifacts");
});

test("KV reads require an explicit permission before loading stored records", () => {
  const handlers = new Map();
  const permissions = [];
  let reads = 0;
  const app = Object.fromEntries(["get", "put", "delete"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  registerKvRoutes({
    app, dbStore: new Proxy({}, { get: () => () => { reads++; throw new Error("KV read must not reach storage when denied"); } }),
    safeString: String, summarizeValue: String, inferNamespace: () => "test",
    valueSize: () => 0, valueType: () => "string", auditLog: () => { reads++; }, requireIdentityAdministrator: () => false,
    requireIdentityPermission: (_req, res, permission) => { permissions.push(permission); res.status(403).json({ code: "forbidden" }); return false; },
    errorResponse: () => { reads++; },
  });
  for (const route of ["GET /api/kv", "GET /api/kv/projects"]) {
    assert.equal(invoke(handlers.get(route)).statusCode, 403, route);
  }
  assert.deepEqual(permissions, ["kv.read", "kv.read"]);
  assert.equal(reads, 0);
});

test("KV writes commit with actor audit and require write-ahead audit availability", () => {
  const handlers = new Map();
  const events = [];
  const state = new Map([["existing", { value: "before", project: "project-a", category: "system" }]]);
  let failRequestAudit = false;
  let failCompletionAudit = false;
  let failIdentityAudit = false;
  const db = {
    transaction(fn) {
      return () => {
        const snapshot = new Map(state);
        try { return fn(); }
        catch (error) { state.clear(); for (const [key, value] of snapshot) state.set(key, value); throw error; }
      };
    },
  };
  const dbStore = {
    getDb: () => db,
    getKV: key => { events.push("storage:get"); return state.get(key) || null; },
    setKV: (key, value, project, source, category) => { events.push("storage:set"); state.set(key, { value, project, source, category }); },
    hasKV: key => { events.push("storage:has"); return state.has(key); },
    deleteKV: key => { events.push("storage:delete"); state.delete(key); },
  };
  const app = Object.fromEntries(["get", "put", "delete"].map(method => [method, (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler)]));
  const errorResponse = (_req, res, _error, options) => res.status(options.status).json({ code: options.code });
  registerKvRoutes({
    app, dbStore, safeString: String, summarizeValue: String, inferNamespace: () => "test",
    valueSize: () => 0, valueType: () => "string",
    auditLog: (_req, action) => {
      events.push(`file:${action}`);
      if (failRequestAudit && action.endsWith(".requested")) throw new Error("audit unavailable");
      if (failCompletionAudit && !action.endsWith(".requested")) throw new Error("completion audit unavailable");
    },
    recordIdentityAudit: (eventType, _principalId, actorId, details) => {
      events.push(`identity:${eventType}:${actorId}`);
      assert.equal(details.key, "existing");
      if (failIdentityAudit) throw new Error("durable audit unavailable");
    },
    requireIdentityAdministrator: () => true,
    requireIdentityPermission: () => true,
    errorResponse,
  });

  const request = { params: { key: "existing" }, body: { value: "after" }, authPrincipal: { principal_id: "owner-1" } };
  const updated = invoke(handlers.get("PUT /api/kv/:key"), request);
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(events, [
    "file:kv.update.requested", "storage:get", "storage:set",
    "identity:dashboard.kv.updated:owner-1", "file:kv.update",
  ]);
  assert.deepEqual(state.get("existing").value, "after");

  events.length = 0;
  const deleted = invoke(handlers.get("DELETE /api/kv/:key"), { params: { key: "existing" }, authPrincipal: { principal_id: "owner-1" } });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(events, [
    "file:kv.delete.requested", "storage:has", "storage:delete",
    "identity:dashboard.kv.deleted:owner-1", "file:kv.delete",
  ]);
  assert.equal(state.has("existing"), false);

  state.set("existing", { value: "before", project: "project-a" });
  failCompletionAudit = true;
  const completedWithDegradedFileAudit = invoke(handlers.get("PUT /api/kv/:key"), request);
  assert.equal(completedWithDegradedFileAudit.statusCode, 200);
  assert.equal(completedWithDegradedFileAudit.body.audit_status, "degraded");
  assert.equal(state.get("existing").value, "after", "a successful durable transaction must not be reported as an ambiguous failed mutation");
  failCompletionAudit = false;
  state.set("existing", { value: "before", project: "project-a" });

  for (const [route, invokeRequest] of [
    ["PUT /api/kv/:key", () => invoke(handlers.get("PUT /api/kv/:key"), request)],
    ["DELETE /api/kv/:key", () => invoke(handlers.get("DELETE /api/kv/:key"), { params: { key: "existing" }, authPrincipal: { principal_id: "owner-1" } })],
  ]) {
    failRequestAudit = true;
    events.length = 0;
    const denied = invokeRequest();
    assert.equal(denied.statusCode, 503, route);
    assert.equal(denied.body.code, "audit_unavailable", route);
    assert.equal(state.has("existing"), true, `${route} must not mutate when write-ahead audit fails`);
    assert.equal(events.filter(event => event.startsWith("storage:")).length, 0, `${route} must not reach storage when audit fails`);
    failRequestAudit = false;

    failIdentityAudit = true;
    events.length = 0;
    const rolledBack = invokeRequest();
    assert.equal(rolledBack.statusCode, 503, route);
    assert.equal(rolledBack.body.code, "audit_unavailable", route);
    assert.deepEqual(state.get("existing").value, "before", `${route} must roll back if durable actor audit fails`);
    failIdentityAudit = false;
  }
});

test("tool logs require audit.read before querying stored arguments and results", () => {
  const harness = makeHarness(registerLogsRoute);
  const response = invoke(harness.handlers.get("GET /api/logs"));
  assert.equal(response.statusCode, 403);
  assert.deepEqual(harness.permissions, ["audit.read"]);
  assert.equal(harness.sideEffects, 0, "denied audit reads must not reach the log database");
});

test("audit log limits cannot become unbounded through negative or oversized values", () => {
  const handlers = new Map();
  const limits = [];
  registerLogsRoute({
    app: { get: (route, handler) => handlers.set(route, handler) },
    dbStore: { queryToolLogs: options => { limits.push(options.limit); return []; } },
    normalizeLogEntry: entry => entry,
    buildActivitySessions: () => [],
    summarizeActivity: () => ({}),
    fallbackGapMs: 1000,
    requireIdentityPermission: () => true,
    errorResponse: () => assert.fail("unexpected log error"),
  });
  for (const limit of ["-1", "-999999", "999999"]) {
    invoke(handlers.get("/api/logs"), { query: { limit } });
  }
  assert.deepEqual(limits, [100, 100, 1000]);
});

test("handoff list limits cannot become unbounded through negative or oversized values", () => {
  const handlers = new Map();
  const limits = [];
  registerHandoffReadRoutes({
    app: { get: (route, handler) => handlers.set(route, handler) },
    dbStore: { listHandoffs: options => { limits.push(options.limit); return []; } },
    errorResponse: () => assert.fail("unexpected handoff error"),
  });
  for (const limit of ["-1", "-999999", "999999"]) {
    invoke(handlers.get("/api/handoffs"), { query: { limit } });
  }
  assert.deepEqual(limits, [50, 50, 500]);
});

test("Blackbox source reads reject negative pagination and cap artifact chunks", () => {
  const handlers = new Map();
  const reads = [];
  registerBlackboxRoutes({
    app: { get: (route, handler) => handlers.set(route, handler), post() {}, patch() {}, delete() {} },
    blackbox: { getSource: (_id, options) => { reads.push(options); return { stdout: "bounded" }; } },
    requireIdentityPermission: () => true,
    hasIdentityPermission: () => true,
    blackboxJson: (_req, res, action) => res.json(action()),
    governedDashboardMutation: () => {},
    errorResponse: () => assert.fail("unexpected Blackbox error"),
  });
  const handler = handlers.get("/api/blackbox/sources/:id");
  const deniedOffset = invoke(handler, { params: { id: "source-1" }, query: { offset: "-1" } });
  const deniedLimit = invoke(handler, { params: { id: "source-1" }, query: { limit: "-1" } });
  assert.equal(deniedOffset.statusCode, 400);
  assert.equal(deniedLimit.statusCode, 400);
  invoke(handler, { params: { id: "source-1" }, query: { offset: "0", limit: "99999999" } });
  assert.deepEqual(reads, [{ offset: 0, limit: 65536 }]);
});

test("memory list requires an explicit granted project for non-admin principals", () => {
  const harness = makeHarness(registerMemoryReadRoutes);
  const denied = invoke(harness.handlers.get("GET /api/memories"), { query: { project: "secret_project" } });
  assert.equal(denied.statusCode, 403);
  const unscoped = invoke(harness.handlers.get("GET /api/memories"), { query: {} });
  assert.equal(unscoped.statusCode, 400);
  assert.equal(harness.sideEffects, 0, "memory storage must not be queried when scope is missing or denied");
});

test("memory list returns only the granted project and excludes unscoped global records", () => {
  const harness = makeHarness(registerMemoryReadRoutes, {
    projectAccess: {
      hasGlobalProjectAccess: () => false,
      hasGlobalMemoryAccess: () => false,
      hasProjectAccess: (_principalId, project) => project === "allowed_project",
      listAccessibleProjects: () => [{ project_id: "allowed_project" }],
    },
    dbStore: {
      searchMemories: () => [
        { id: "a", project: "allowed_project", content: "allowed" },
        { id: "b", project: "other_project", content: "denied" },
        { id: "g", project: null, content: "global" },
      ],
    },
  });
  const response = invoke(harness.handlers.get("GET /api/memories"), { query: { project: "allowed_project" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.memories.map(memory => memory.id), ["a"]);
});

test("dashboard performance snapshot fails closed unless operations-read permission is granted", () => {
  const handlers = new Map();
  let reads = 0;
  const app = { get: (route, handler) => handlers.set(route, handler) };
  registerPerformanceRoutes({ app, metrics: { snapshot: () => { reads++; return { requests: 1 }; } }, errorResponse: () => assert.fail("unexpected error") });
  const unavailable = invoke(handlers.get("/api/dashboard-performance"));
  assert.equal(unavailable.statusCode, 503);
  assert.equal(reads, 0);

  registerPerformanceRoutes({
    app,
    metrics: { snapshot: () => { reads++; return { requests: 1 }; } },
    errorResponse: () => assert.fail("unexpected error"),
    requireIdentityPermission: (_req, res) => { res.status(403).json({ code: "forbidden" }); return false; },
  });
  const denied = invoke(handlers.get("/api/dashboard-performance"));
  assert.equal(denied.statusCode, 403);
  assert.equal(reads, 0);

  registerPerformanceRoutes({
    app,
    metrics: { snapshot: () => { reads++; return { requests: 1 }; } },
    errorResponse: () => assert.fail("unexpected error"),
    requireIdentityPermission: (_req, _res, permission) => { assert.equal(permission, "dashboard.operations.read"); return true; },
  });
  const allowed = invoke(handlers.get("/api/dashboard-performance"));
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.body.metrics, { requests: 1 });
  assert.equal(reads, 1);
});

test("database backup requires an attributable audit record before export", async () => {
  const handlers = new Map();
  const events = [];
  let backups = 0;
  const app = {
    get: (route, handler) => handlers.set(route, handler),
    post: (route, handler) => handlers.set(route, handler),
  };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const request = { body: {}, params: {}, query: {}, authPrincipal: { principal_id: "backup-actor" } };
  let dispatchResult = { content: [{ type: "text", text: "Backup created" }] };
  const register = auditLog => registerDatabaseRoutes({
    app, dbStore: { getDb: () => ({ backup: async () => { assert.fail("backup route must use the canonical dispatcher"); } }) },
    dataDir: "C:/sidekick-test-data", path: require("node:path"), fs: { mkdirSync() {} },
    callDashboardTool: async (tool, args) => {
      assert.equal(tool, "db_backup");
      assert.equal(args.compress, false);
      events.push("dispatch");
      if (!dispatchResult.isError) backups++;
      return dispatchResult;
    }, dashboardExecutionMetadata: () => ({}), authenticatedUser: () => "backup-actor",
    requireDashboardTool: () => true, requireIdentityPermission: () => true, auditLog,
    errorResponse: (_req, res, error, options) => res.status(options.status).json({ error: error?.message || "audit failed", code: options.code }),
  });
  register((req, action) => { events.push(action); if (action === "db.backup.requested") throw new Error("audit unavailable"); });
  await handlers.get("/api/db/backup")(request, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "audit_unavailable");
  assert.equal(backups, 0, "backup must not be exported when the request audit cannot be stored");

  events.length = 0;
  response.statusCode = 200;
  register((req, action) => events.push(action));
  await handlers.get("/api/db/backup")(request, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(events, ["db.backup.requested", "dispatch", "db.backup.completed"]);
  assert.equal(backups, 1);

  events.length = 0;
  response.statusCode = 200;
  register((req, action) => { events.push(action); if (action === "db.backup.completed") throw new Error("completion audit unavailable"); });
  await handlers.get("/api/db/backup")(request, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.audit_status, "degraded");
  assert.deepEqual(events, ["db.backup.requested", "dispatch", "db.backup.completed"]);
  assert.equal(backups, 2);

  events.length = 0;
  response.statusCode = 200;
  response.body = undefined;
  dispatchResult = { isError: true, approvalRequired: true, approvalId: "approval-1" };
  register((req, action) => events.push(action));
  await handlers.get("/api/db/backup")(request, response);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, { ok: false, code: "approval_required", approval_id: "approval-1" });
  assert.deepEqual(events, ["db.backup.requested", "dispatch"]);
  assert.equal(backups, 2, "a queued backup must not create the artifact before approval");
});

test("direct database routes enforce their identity permission before accessing state", async () => {
  const handlers = new Map();
  const app = {
    get: (route, handler) => handlers.set(route, handler),
    post: (route, handler) => handlers.set(route, handler),
  };
  const permissions = [];
  let stateReads = 0;
  registerDatabaseRoutes({
    app,
    dbStore: { getDb: () => { stateReads++; throw new Error("database must not be touched"); } },
    dataDir: "C:/sidekick-test-data", path: require("node:path"), fs: { mkdirSync: () => { stateReads++; } },
    callDashboardTool: async () => { stateReads++; return {}; },
    dashboardExecutionMetadata: () => ({}), authenticatedUser: () => "low-privilege-user",
    requireDashboardTool: () => { stateReads++; return true; },
    requireIdentityPermission: (_req, res, permission) => {
      permissions.push(permission);
      res.status(403).json({ error: "Forbidden", code: "forbidden", permission });
      return false;
    },
    auditLog: () => { stateReads++; },
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });

  const invoke = async route => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handlers.get(route)({ body: {}, params: {}, query: {} }, response);
    assert.equal(response.statusCode, 403, route);
    assert.equal(response.body.code, "forbidden", route);
  };
  await invoke("/api/db/schema");
  await invoke("/api/db/stats");
  await invoke("/api/db/backup");
  await invoke("/api/db/migrations");

  assert.deepEqual(permissions, ["database.inspect", "database.inspect", "tools.execute", "tools.execute_high"]);
  assert.equal(stateReads, 0, "denied callers must not reach direct database/filesystem operations or policy checks");
});

test("authorized database read routes use canonical dispatcher tools and preserve response shapes", async () => {
  const handlers = new Map();
  const app = {
    get: (route, handler) => handlers.set(`GET ${route}`, handler),
    post: (route, handler) => handlers.set(`POST ${route}`, handler),
  };
  const dispatches = [];
  registerDatabaseRoutes({
    app,
    dbStore: { getDb: () => { throw new Error("direct DB reads must not run"); } },
    dataDir: "C:/sidekick-test-data", path: require("node:path"), fs: { statSync: () => { throw new Error("direct filesystem reads must not run"); } },
    callDashboardTool: async (name, args) => {
      dispatches.push({ name, args });
      const values = {
        db_schema: [{ name: "memories", columns: [{ name: "id" }], indexes: [], rowCount: 12 }],
        db_stats: { dbSize: 100, totalTables: 1, journalMode: "wal", pageCount: 1, pageSize: 4096 },
        db_migrate: { currentVersion: 4, migrations: [{ file: "004_test.sql", version: 4, applied: true }] },
      };
      return { content: [{ type: "text", text: JSON.stringify(values[name]) }] };
    },
    dashboardExecutionMetadata: (_req, actor) => ({ actor, authIdentity: { principal_id: "db-reader" } }),
    authenticatedUser: () => "db-reader", requireDashboardTool: () => true,
    requireIdentityPermission: () => true, auditLog: () => {},
    errorResponse: (_req, res, _error, options) => res.status(options.status).json({ code: options.code }),
  });
  const invoke = async (method, route) => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handlers.get(`${method} ${route}`)({ query: {}, params: {}, body: {} }, response);
    assert.equal(response.statusCode, 200, route);
    return response.body;
  };

  assert.deepEqual((await invoke("GET", "/api/db/schema")).schema, {
    memories: { columns: [{ name: "id" }], indexes: [], rowCount: 12 },
  });
  assert.deepEqual(await invoke("GET", "/api/db/stats"), {
    ok: true, size: 100, tableCount: 1, walMode: "wal", dbSize: 4096,
  });
  assert.deepEqual(await invoke("GET", "/api/db/migrations"), {
    ok: true, currentVersion: 4, migrations: [{ file: "004_test.sql", version: 4, applied: true }],
  });
  assert.deepEqual(dispatches.map(call => call.name), ["db_schema", "db_stats", "db_migrate"]);
  assert.equal(dispatches[0].args.verbose, true);
  assert.equal(dispatches[1].args.detailed, false);
  assert.equal(dispatches[2].args.action, "status");
});
