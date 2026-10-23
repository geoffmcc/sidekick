"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { abortUpstreamOnDisconnect } = require("../src/dashboard/upstream-lifecycle");

function pair() {
  const response = new EventEmitter();
  response.writableEnded = false;
  const upstream = { destroyed: false, destroy() { this.destroyed = true; } };
  return { response, upstream };
}

test("upstream read is cancelled when its client disconnects", () => {
  const { response, upstream } = pair();
  abortUpstreamOnDisconnect(response, upstream);
  response.emit("close");
  assert.equal(upstream.destroyed, true);
});

test("completed response does not abort its upstream after normal close", () => {
  const { response, upstream } = pair();
  abortUpstreamOnDisconnect(response, upstream);
  response.writableEnded = true;
  response.emit("close");
  assert.equal(upstream.destroyed, false);
});

test("only read-only Grafana and Agent routes bind disconnect cancellation", () => {
  const dashboard = fs.readFileSync(path.join(__dirname, "../src/dashboard.js"), "utf8");
  const agent = fs.readFileSync(path.join(__dirname, "../src/dashboard/agent-proxy-routes.js"), "utf8");
  assert.match(dashboard, /req\.method === "GET" \|\| req\.method === "HEAD"\) abortUpstreamOnDisconnect\(res, proxyReq\)/);
  assert.match(agent, /if \(method === "GET"\)[\s\S]{0,220}abortUpstreamOnDisconnect\(res, upstream\)/);
});
