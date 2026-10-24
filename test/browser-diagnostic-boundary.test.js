"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyError } = require("../src/browser/actions");

test("browser diagnostics retain the failing origin without echoing URL secrets", () => {
  const secret = "synthetic-browser-url-secret-6c91";
  const error = classifyError(new Error(
    `page.goto: net::ERR_CONNECTION_REFUSED at https://user:${secret}@example.invalid/private/${secret}?token=${secret}#${secret}`
  ));

  assert.equal(error.category, "navigation_failed");
  assert.match(error.message, /https:\/\/example\.invalid/);
  assert.ok(!error.message.includes(secret));
  assert.ok(!error.message.includes("/private/"));
  assert.ok(!error.message.includes("token="));
});

test("browser timeout diagnostics redact URLs while preserving useful locator context", () => {
  const secret = "synthetic-timeout-secret-2d34";
  const error = classifyError(new Error(
    `Timeout 1000ms exceeded while waiting for https://user:${secret}@example.invalid/path?token=${secret}`
  ));

  assert.equal(error.category, "timeout");
  assert.match(error.message, /Timed out: Timeout 1000ms exceeded/);
  assert.match(error.message, /https:\/\/example\.invalid/);
  assert.ok(!error.message.includes(secret));
});
