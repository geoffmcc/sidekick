"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const { test } = require("node:test");
const { parseTrustedProxyConfig } = require("../../src/security/trusted-proxies");

test("legacy proxy trust setting is limited to loopback", () => {
  const app = express();
  app.set("trust proxy", parseTrustedProxyConfig("true"));
  const trust = app.get("trust proxy fn");
  assert.equal(trust("127.0.0.1", 0), true);
  assert.equal(trust("::1", 0), true);
  assert.equal(trust("192.0.2.10", 0), false, "legacy true cannot trust an arbitrary remote peer");
  assert.equal(parseTrustedProxyConfig("false"), false);
  assert.equal(parseTrustedProxyConfig(""), false);
});

test("explicit reverse proxy IPs and CIDRs are parsed without trusting arbitrary peers", () => {
  const app = express();
  app.set("trust proxy", parseTrustedProxyConfig("127.0.0.1,10.20.0.0/16,2001:db8::/32"));
  const trust = app.get("trust proxy fn");
  assert.equal(trust("10.20.9.8", 0), true);
  assert.equal(trust("10.21.0.1", 0), false);
  assert.equal(trust("2001:db8::10", 0), true);
  assert.equal(trust("2001:dead::10", 0), false);
  assert.throws(() => parseTrustedProxyConfig("proxy.example.invalid"), /IP addresses or CIDRs/);
  assert.throws(() => parseTrustedProxyConfig("0.0.0.0/0"), /prefix from 1/);
  assert.throws(() => parseTrustedProxyConfig("::/0"), /prefix from 1/);
  assert.throws(() => parseTrustedProxyConfig("10.0.0.1/33"), /prefix from 1/);
});
