"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { after, test } = require("node:test");
const https = require("node:https");
const { probeHttps } = require("../src/tools/families/observability");

const originalRequest = https.request;
after(() => { https.request = originalRequest; });

test("observability HEAD probe closes an unused body after recording status", async () => {
  const events = [];
  https.request = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 204;
      response.destroy = () => events.push("destroy");
      callback(response);
    };
    return request;
  };
  const result = await probeHttps(new URL("https://metrics.example/health"));
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 204);
  assert.deepEqual(events, ["destroy"]);
});
