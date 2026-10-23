"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { boundedResponseText, MAX_RESPONSE_BYTES } = require("../src/certification/lifecycle");

test("certification client reads a bounded response body", async () => {
  const response = new Response(JSON.stringify({ ok: true }));
  assert.equal(await boundedResponseText(response), '{"ok":true}');
});

test("certification client cancels an oversized response stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedResponseText({ body }), /response exceeds the size bound/);
  assert.equal(cancelled, true);
});

test("certification client rejects response objects without a bounded stream", async () => {
  await assert.rejects(
    boundedResponseText({ body: null, text: async () => "unbounded" }),
    /response stream is unavailable/
  );
});
