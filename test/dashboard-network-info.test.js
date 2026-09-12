"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { inspectNetworkInterfaces, privateIPv4 } = require("../src/dashboard/network-info");

test("network info accepts valid interfaces and returns a private IPv4", () => {
  const info = inspectNetworkInterfaces(() => ({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }], eth0: [{ address: "10.0.0.4", family: "IPv4", internal: false }] }));
  assert.equal(info.diagnostic, null);
  assert.equal(privateIPv4(info), "10.0.0.4");
});

test("network info treats empty interfaces as an honest unknown", () => {
  const info = inspectNetworkInterfaces(() => ({}));
  assert.equal(info.diagnostic, null);
  assert.equal(privateIPv4(info), "unknown");
});

test("network info ignores malformed entries and reports degradation", () => {
  const info = inspectNetworkInterfaces(() => ({ eth0: [null, { address: "10.0.0.4", family: 4, internal: false }], bad: "not-an-array" }));
  assert.equal(info.diagnostic.code, "network_interfaces_malformed");
  assert.equal(privateIPv4(info), "10.0.0.4");
});

test("network info catches enumeration failures without inventing an address", () => {
  const info = inspectNetworkInterfaces(() => { throw new Error("permission denied"); });
  assert.equal(info.diagnostic.code, "network_interfaces_unavailable");
  assert.equal(privateIPv4(info), "unknown");
});
