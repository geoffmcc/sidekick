"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const dns = require("node:dns");
const http = require("node:http");

const qdrant = require("../src/qdrant");

test("Qdrant rejects protected DNS answers, pins allowed results, does not follow redirects, and times out", async t => {
  const originalLookup = dns.promises.lookup;
  const lookupCalls = [];
  dns.promises.lookup = async hostname => {
    lookupCalls.push(hostname);
    if (hostname === "rebound.example") {
      return [
        { address: "127.0.0.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ];
    }
    return [{ address: "127.0.0.1", family: 4 }];
  };
  t.after(() => { dns.promises.lookup = originalLookup; });

  let requests = 0;
  const redirectServer = http.createServer((req, res) => {
    requests++;
    assert.match(req.headers.host, /^public\.example:\d+$/);
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  await new Promise(resolve => redirectServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => redirectServer.close(resolve)));

  await assert.rejects(
    qdrant.qdrantRequest(`http://rebound.example:${redirectServer.address().port}/`),
    /protected link-local or metadata endpoint/,
  );
  assert.equal(requests, 0, "no connection is made when any DNS answer is protected");

  const url = `http://public.example:${redirectServer.address().port}/`;
  const response = await qdrant.qdrantRequest(url);
  assert.equal(response.status, 302);
  await response.body?.cancel();
  assert.equal(requests, 1, "redirect destinations must not receive a request");
  assert.equal(lookupCalls.filter(hostname => hostname === "public.example").length, 1, "the validated DNS address must be pinned for the socket");

  const slowServer = http.createServer(() => {});
  await new Promise(resolve => slowServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => slowServer.close(resolve)));
  await assert.rejects(
    qdrant.qdrantRequest(`http://127.0.0.1:${slowServer.address().port}/`, { signal: AbortSignal.timeout(50) }),
    /abort|timeout/i,
  );
});

test("Qdrant JSON responses are rejected when their streamed body exceeds the bound", async () => {
  await assert.rejects(
    qdrant.readBoundedJson(new Response("0123456789"), 5),
    /Qdrant response exceeded the configured size limit/,
  );
  assert.deepEqual(await qdrant.readBoundedJson(new Response('{"result":[]}'), 32), { result: [] });
});

test("Qdrant JSON responses fail closed when bounded streaming is unavailable", async () => {
  let textFallbackCalled = false;
  await assert.rejects(qdrant.readBoundedJson({
    body: { getReader: null },
    async text() { textFallbackCalled = true; return "{}"; },
  }, 32), /cannot be read with a bounded stream/);
  assert.equal(textFallbackCalled, false);
});

test("Qdrant semantic search rejects an oversized response and cancels the body", async t => {
  const originalBaseUrl = qdrant.baseUrl;
  const responses = [];
  t.after(() => {
    qdrant.baseUrl = originalBaseUrl;
  });

  const server = http.createServer((req, res) => {
    if (req.url.endsWith("/points/search")) {
      responses.push(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(Buffer.alloc(qdrant.MAX_RESPONSE_BYTES + 1, 0x20));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: [] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  qdrant.baseUrl = `http://127.0.0.1:${server.address().port}`;
  let calls = 0;
  server.on("request", () => { calls++; });

  await assert.rejects(qdrant.search(new Array(768).fill(0), 10), /response exceeded the configured size limit/);
  assert.equal(calls, 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(responses[0].destroyed || responses[0].writableEnded, "the oversized response stream is abandoned after crossing the bound");
});
