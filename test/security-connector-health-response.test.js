"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resultFromProbeHeaders, finishProbeFromHeaders } = require("../src/connectors/health");

test("GitHub health probe uses status headers and closes the unused body afterward", () => {
  const events = [];
  const response = {
    statusCode: 200,
    destroy() { events.push("destroy"); },
  };
  let result;
  finishProbeFromHeaders(response, "https://github.example", value => { result = value; events.push("resolve"); });
  assert.deepEqual(result, { ok: true, status: 200, endpoint: "https://github.example" });
  assert.deepEqual(events, ["resolve", "destroy"]);
});

test("GitHub health probe preserves failure status and maps status without side effects", () => {
  const response = {
    statusCode: 503,
  };
  assert.deepEqual(resultFromProbeHeaders(response, "https://github.example"), {
    ok: false, status: 503, endpoint: "https://github.example",
  });
});
