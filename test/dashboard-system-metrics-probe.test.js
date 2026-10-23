"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { registerSystemRoutes } = require("../src/dashboard/system-routes");

async function runMetricsProbe(statusCode) {
  const routes = new Map();
  const events = [];
  const app = { get: (route, handler) => routes.set(route, handler) };
  const http = {
    get(_options, callback) {
      const request = new EventEmitter();
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.destroy = () => events.push("destroy");
      queueMicrotask(() => callback(response));
      return request;
    },
  };
  registerSystemRoutes({
    app,
    systemSnapshot: () => ({}),
    systemctlStatus: () => "active",
    getJsonFromLocalService: async () => ({}),
    http,
    grafanaPort: 3000,
    grafanaConfigured: true,
    influxConfigured: true,
    requireIdentityPermission: () => true,
    errorResponse() {},
  });
  let payload;
  await routes.get("/api/metrics/status")({}, { json: value => { payload = value; } });
  return { payload, events };
}

test("Influx health probe records the status and closes the unused response body", async () => {
  const { payload, events } = await runMetricsProbe(204);
  assert.equal(payload.influxdb.reachable, true);
  assert.deepEqual(events, ["destroy"]);
});

test("Influx health probe marks server errors unreachable and closes the body", async () => {
  const { payload, events } = await runMetricsProbe(503);
  assert.equal(payload.influxdb.reachable, false);
  assert.deepEqual(events, ["destroy"]);
});
