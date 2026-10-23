"use strict";

const assert = require("node:assert/strict");
const dns = require("node:dns");
const { Readable } = require("node:stream");
const { after, test } = require("node:test");
const https = require("node:https");
const { probeHttps, readInfluxResponseText } = require("../src/tools/families/observability");

const originalRequest = https.request;
const originalLookup = dns.promises.lookup;
after(() => { https.request = originalRequest; dns.promises.lookup = originalLookup; });

test("observability HEAD probe pins DNS and preserves the HTTPS host", async () => {
  let requestOptions;
  dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  https.request = (options, callback) => {
    requestOptions = options;
    const request = {
      on() { return this; },
      end() {
        const response = Readable.from([]);
        response.statusCode = 204;
        response.statusMessage = "No Content";
        response.headers = {};
        callback(response);
      },
      destroy() {},
    };
    return request;
  };
  const result = await probeHttps(new URL("https://metrics.example/health"));
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 204);
  assert.equal(requestOptions.hostname, "93.184.216.34");
  assert.equal(requestOptions.servername, "metrics.example");
  assert.equal(requestOptions.headers.Host, "metrics.example");
  assert.equal(requestOptions.method, "HEAD");
});

test("observability HTTPS probe refuses mixed public and metadata DNS answers", async () => {
  let requestCount = 0;
  dns.promises.lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ];
  https.request = () => { requestCount++; throw new Error("must not connect"); };
  const result = await probeHttps("https://metrics.example/health");
  assert.equal(result.ok, false);
  assert.match(result.error, /protected link-local or metadata/);
  assert.equal(requestCount, 0);
});

test("observability network probe refuses non-HTTPS endpoints", async () => {
  let lookupCount = 0;
  dns.promises.lookup = async () => { lookupCount++; return [{ address: "93.184.216.34", family: 4 }]; };
  const result = await probeHttps("http://metrics.example/health");
  assert.equal(result.ok, false);
  assert.match(result.error, /must use HTTPS/);
  assert.equal(lookupCount, 0);
});

test("Influx response reader fails closed when bounded streaming is unavailable", async () => {
  let textFallbackCalled = false;
  await assert.rejects(readInfluxResponseText({
    body: { getReader: null },
    async text() { textFallbackCalled = true; return "small response"; },
  }), /cannot be read with a bounded stream/);
  assert.equal(textFallbackCalled, false);
});

test("Influx response reader accepts an empty body without a stream", async () => {
  assert.equal(await readInfluxResponseText({ body: null }), "");
});
