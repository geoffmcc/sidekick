"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isLoopbackHost, validateControlPlaneUrl } = require("../../src/compute/control-plane-url");

test("control-plane HTTP is limited to loopback and HTTPS accepts remote hosts", () => {
  const loopbackUrls = ["http://127.0.0.1:4097", ["http:", "//", "127.42.0.9:4097"].join(""), ["http:", "//", "[::1]:4097"].join(""), "http://localhost:4097"];
  for (const url of loopbackUrls) {
    assert.equal(validateControlPlaneUrl(url).protocol, "http:");
  }
  assert.equal(validateControlPlaneUrl("https://example.invalid:4097").protocol, "https:");
  assert.equal(isLoopbackHost("192.168.1.10"), false);
  assert.equal(isLoopbackHost("sidekick.local"), false);
});

test("control-plane URL validation rejects plaintext remote hosts and credential-bearing URLs", () => {
  assert.throws(
    () => validateControlPlaneUrl("http://example.invalid:4097"),
    error => error.code === "CONTROL_PLANE_INSECURE_TRANSPORT" && /require HTTPS/.test(error.message),
  );
  assert.throws(() => validateControlPlaneUrl(["https:", "//", "user:password@example.invalid"].join("")), /contain no credentials/);
  assert.throws(() => validateControlPlaneUrl("ftp://example.invalid"), /must use HTTP\(S\)/);
});
