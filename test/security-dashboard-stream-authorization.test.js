"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerEvolveRoutes } = require("../src/dashboard/evolve-routes");
const { registerBlackboxRoutes } = require("../src/dashboard/blackbox-routes");

function harnessResponse() {
  return {
    statusCode: 200,
    chunks: [],
    writeResult: true,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    writeHead(code) { this.statusCode = code; },
    write(chunk) { this.chunks.push(String(chunk)); return this.writeResult; },
    end() { this.ended = true; },
  };
}

function makeApp() {
  const handlers = new Map();
  return {
    handlers,
    app: { get: (route, handler) => handlers.set(route, handler), post: () => {} },
  };
}

test("generated execution read routes require operations permission and recheck open streams", async () => {
  const { app, handlers } = makeApp();
  let allowed = false;
  let reads = 0;
  let executionListener;
  registerEvolveRoutes({
    app,
    evolveDashboardAction() {}, authenticatedUser() { return "viewer"; },
    dbStore: {
      listGeneratedToolExecutions() { reads++; return []; },
      getGeneratedToolExecution() { reads++; return null; },
    },
    shapeExecution: value => value,
    requireAttributedActor() {}, requireIdentityPermission(_req, res) {
      if (!allowed) { res.status(403).json({ code: "forbidden" }); return false; }
      return true;
    },
    hasIdentityPermission: () => allowed,
    crypto: {}, callDashboardTool() {}, dashboardExecutionMetadata() {}, redactSensitive: String,
    auditLog() {},
    dynamicTools: { cancelExecution() {}, onExecutionEvent(callback) { executionListener = callback; return () => {}; } },
    logError() {}, errorResponse() {},
  });

  for (const route of ["/api/evolve/executions", "/api/evolve/executions/:executionId"]) {
    const res = harnessResponse();
    handlers.get(route)({ query: {}, params: { executionId: "execution-1" } }, res);
    assert.equal(res.statusCode, 403, route);
  }
  assert.equal(reads, 0, "denied principals cannot read generated execution records");

  allowed = true;
  const req = { query: {}, params: { executionId: "execution-1" }, on() {} };
  const res = harnessResponse();
  handlers.get("/api/evolve/executions/:executionId/stream")(req, res);
  assert.equal(res.statusCode, 200);
  allowed = false;
  executionListener({ id: "execution-1", finalSummary: "sensitive output" });
  assert.equal(res.ended, true, "permission revocation ends the live execution stream");
  assert.equal(res.chunks.join(""), "", "no execution frame is sent after revocation");

  allowed = true;
  const idleRes = harnessResponse();
  handlers.get("/api/evolve/executions/:executionId/stream")({ ...req, on() {} }, idleRes);
  allowed = false;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(idleRes.ended, true, "periodic authorization polling closes an idle stream after revocation");
});

test("Blackbox capture stream ends and suppresses frames after permission revocation", async () => {
  const { app, handlers } = makeApp();
  let allowed = false;
  let progressListener;
  let reads = 0;
  let permissionResponses = 0;
  registerBlackboxRoutes({
    app: { ...app, patch: () => {}, delete: () => {} },
    blackbox: {
      captureStatus() { reads++; return { state: "running" }; },
      subscribeCapture(_id, callback) { progressListener = callback; return () => {}; },
    },
    requireIdentityPermission(_req, res) {
      if (!allowed) { permissionResponses++; res.status(403).json({ code: "forbidden" }); return false; }
      return true;
    },
    hasIdentityPermission: () => allowed,
    blackboxJson() {}, governedDashboardMutation() {}, errorResponse() {},
  });

  const route = handlers.get("/api/blackbox/captures/:id/stream");
  const denied = harnessResponse();
  route({ params: { id: "capture-1" }, on() {} }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(reads, 0, "denied principals cannot read capture status");
  assert.equal(permissionResponses, 1);

  allowed = true;
  const res = harnessResponse();
  route({ params: { id: "capture-1" }, on() {} }, res);
  assert.match(res.chunks.join(""), /snapshot/);
  allowed = false;
  progressListener({ detail: "sensitive capture progress" });
  assert.equal(res.ended, true, "permission revocation ends the live capture stream");
  assert.doesNotMatch(res.chunks.join(""), /sensitive capture progress/);

  allowed = true;
  const idleRes = harnessResponse();
  route({ params: { id: "capture-2" }, on() {} }, idleRes);
  allowed = false;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(idleRes.ended, true, "periodic authorization polling closes an idle capture stream after revocation");
});

test("slow SSE clients are disconnected when event buffers apply backpressure", () => {
  const { app, handlers } = makeApp();
  let allowed = true;
  let executionListener;
  let executionUnsubscribed = false;
  let blackboxSubscriptions = 0;
  registerEvolveRoutes({
    app,
    evolveDashboardAction() {}, authenticatedUser() { return "viewer"; }, dbStore: { getGeneratedToolExecution() { return null; } },
    shapeExecution: value => value, requireAttributedActor() {}, requireIdentityPermission: () => true,
    hasIdentityPermission: () => allowed, crypto: {}, callDashboardTool() {}, dashboardExecutionMetadata() {}, redactSensitive: String,
    auditLog() {}, dynamicTools: {
      cancelExecution() {},
      onExecutionEvent(callback) { executionListener = callback; return () => { executionUnsubscribed = true; }; },
    },
    logError() {}, errorResponse() {},
  });
  registerBlackboxRoutes({
    app: { ...app, patch() {}, delete() {} },
    blackbox: {
      captureStatus: () => ({ state: "running" }),
      subscribeCapture() { blackboxSubscriptions++; return () => {}; },
    },
    requireIdentityPermission: () => true, hasIdentityPermission: () => allowed,
    blackboxJson() {}, governedDashboardMutation() {}, errorResponse() {},
  });

  const executionRes = harnessResponse();
  executionRes.writeResult = false;
  handlers.get("/api/evolve/executions/:executionId/stream")({ params: { executionId: "execution-slow" }, on() {} }, executionRes);
  executionListener({ id: "execution-slow", state: "running" });
  assert.equal(executionRes.ended, true);
  assert.equal(executionUnsubscribed, true);

  const captureRes = harnessResponse();
  captureRes.writeResult = false;
  handlers.get("/api/blackbox/captures/:id/stream")({ params: { id: "capture-slow" }, on() {} }, captureRes);
  assert.equal(captureRes.ended, true);
  assert.equal(blackboxSubscriptions, 0, "backpressured snapshot must not create a live subscription");
});
