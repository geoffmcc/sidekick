"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { registerAgentProxyRoutes } = require("../src/dashboard/agent-proxy-routes");

function setup() {
  const routes = new Map();
  const upstreams = [];
  const app = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  };
  const http = {
    request() {
      const upstream = new EventEmitter();
      upstream.destroyed = false;
      upstream.destroy = () => { upstream.destroyed = true; };
      upstream.write = () => {};
      upstream.end = () => {};
      upstreams.push(upstream);
      return upstream;
    },
  };
  registerAgentProxyRoutes({ app, http, agentPort: 4099, agentProxySecret: "test-secret", errorResponse() {} });
  return { routes, upstreams };
}

function response() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = () => { res.headersSent = true; };
  res.end = () => { res.writableEnded = true; };
  return res;
}

test("Agent GET relay closes its upstream when the browser disconnects", () => {
  const { routes, upstreams } = setup();
  const res = response();
  routes.get("GET /api/agent/tasks")({ originalUrl: "/api/agent/tasks", authPrincipal: null }, res);
  res.emit("close");
  assert.equal(upstreams[0].destroyed, true);
});

test("Agent POST workflow relay continues after browser disconnect", () => {
  const { routes, upstreams } = setup();
  const res = response();
  routes.get("POST /api/agent/run")({ originalUrl: "/api/agent/run", authPrincipal: null, body: { goal: "durable task" } }, res);
  res.emit("close");
  assert.equal(upstreams[0].destroyed, false);
});
