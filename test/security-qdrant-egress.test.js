"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const qdrant = require("../src/qdrant");

test("Qdrant requests reject redirects and have a finite deadline", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return new Response(null, { status: 204 });
  };

  const response = await qdrant.qdrantRequest("http://127.0.0.1:6333/");
  assert.equal(response.status, 204);
});

test("Qdrant JSON responses are rejected when their streamed body exceeds the bound", async () => {
  await assert.rejects(
    qdrant.readBoundedJson(new Response("0123456789"), 5),
    /Qdrant response exceeded the configured size limit/,
  );
  assert.deepEqual(await qdrant.readBoundedJson(new Response('{"result":[]}'), 32), { result: [] });
});

test("Qdrant semantic search rejects an oversized response and cancels the body", async t => {
  const originalFetch = global.fetch;
  const originalBaseUrl = qdrant.baseUrl;
  t.after(() => {
    global.fetch = originalFetch;
    qdrant.baseUrl = originalBaseUrl;
  });

  qdrant.baseUrl = "http://127.0.0.1:6333";
  let calls = 0;
  let cancelled = false;
  global.fetch = async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    calls++;
    if (calls === 1) return new Response(null, { status: 200 });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(qdrant.MAX_RESPONSE_BYTES + 1));
      },
      cancel() { cancelled = true; },
    });
    return new Response(body, { status: 200 });
  };

  await assert.rejects(qdrant.search(new Array(768).fill(0), 10), /response exceeded the configured size limit/);
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
});
