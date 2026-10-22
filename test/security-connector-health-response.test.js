"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resultFromProbeHeaders } = require("../src/connectors/health");

test("GitHub health probe uses status headers and closes the unused body", () => {
  let destroyed = false;
  const result = resultFromProbeHeaders({
    statusCode: 200,
    destroy() { destroyed = true; },
  }, "https://github.example");
  assert.deepEqual(result, { ok: true, status: 200, endpoint: "https://github.example" });
  assert.equal(destroyed, true);
});

test("GitHub health probe preserves failed status while closing the body", () => {
  let destroyed = false;
  const result = resultFromProbeHeaders({
    statusCode: 503,
    destroy() { destroyed = true; },
  }, "https://github.example");
  assert.deepEqual(result, { ok: false, status: 503, endpoint: "https://github.example" });
  assert.equal(destroyed, true);
});
