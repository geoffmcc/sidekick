"use strict";

const assert = require("node:assert/strict");

function assertNoSyntheticSecret(value, secret) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(text.includes(secret), false, "synthetic secret leaked into test-visible output");
}

function principal(overrides = {}) {
  return { id: "principal-test-owner", type: "human", project: "test-project", roles: ["owner"], permissions: [], ...overrides };
}

module.exports = { assertNoSyntheticSecret, principal };
