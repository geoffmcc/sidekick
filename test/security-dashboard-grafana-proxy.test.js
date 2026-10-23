"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGrafanaProxyHeaders } = require("../src/dashboard/grafana-proxy");

test("Dashboard Grafana proxy replaces caller credentials and identity headers", () => {
  const headers = buildGrafanaProxyHeaders({
    host: "attacker.invalid",
    cookie: "grafana_session=attacker",
    authorization: "Basic attacker-controlled",
    "x-webauth-user": "admin",
    "x-webauth-groups": "admins",
    "x-webauth-role": "Admin",
    "X-WEBAUTH-USER": "case-variant-admin",
    accept: "text/html",
  }, "sidekick", "synthetic-grafana-secret");

  assert.equal(headers.authorization, `Basic ${Buffer.from("sidekick:synthetic-grafana-secret").toString("base64")}`);
  assert.equal(headers.accept, "text/html");
  for (const name of Object.keys(headers)) assert.doesNotMatch(name, /^x-webauth-/i);
  for (const name of ["host", "cookie"]) assert.equal(Object.hasOwn(headers, name), false, `${name} must not reach Grafana`);
  assert.doesNotMatch(JSON.stringify(headers), /attacker-controlled|grafana_session|synthetic-grafana-secret/);
});

test("Dashboard Grafana proxy fails closed without its password", () => {
  assert.throws(() => buildGrafanaProxyHeaders({}, "sidekick", ""), /credentials are unavailable/);
});
