"use strict";

const assert = require("node:assert/strict");
const dns = require("node:dns");
const http = require("node:http");
const { after, test } = require("node:test");
const { requestJson } = require("../../src/compute/provider-http");

const originalLookup = dns.promises.lookup;
let server;

after(async () => {
  dns.promises.lookup = originalLookup;
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test("provider HTTP errors expose status without retaining untrusted response bodies", async () => {
  const syntheticCredential = "synthetic-provider-credential-DO-NOT-LEAK";
  server = http.createServer((req, res) => {
    res.statusCode = req.url === "/rate-limit" ? 429 : 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: `Authorization failed; api_key=${syntheticCredential}` } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  dns.promises.lookup = async () => [{ address: "127.0.0.1", family: 4 }];

  await assert.rejects(
    () => requestJson({ endpoint: `http://example.invalid:${port}`, path: "/unauthorized", label: "provider endpoint", errorPrefix: "Provider" }),
    error => {
      assert.equal(error.code, "HTTP_401");
      assert.equal(error.message, "Provider request failed (HTTP 401)");
      assert.doesNotMatch(error.message, new RegExp(syntheticCredential));
      return true;
    },
  );

  await assert.rejects(
    () => requestJson({ endpoint: `http://example.invalid:${port}`, path: "/rate-limit", label: "provider endpoint", errorPrefix: "Provider", rateLimitError: "Rate limited" }),
    error => {
      assert.equal(error.code, "HTTP_429");
      assert.equal(error.message, "Rate limited");
      assert.doesNotMatch(error.message, new RegExp(syntheticCredential));
      return true;
    },
  );
});
