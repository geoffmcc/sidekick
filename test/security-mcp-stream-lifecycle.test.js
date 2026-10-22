"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { relayResponseBody } = require("../src/mcp/streamable-http");

function responseStub(writeResults = []) {
  const response = new EventEmitter();
  response.writableEnded = false;
  response.writes = [];
  response.write = chunk => {
    response.writes.push(Buffer.from(chunk).toString("utf8"));
    return writeResults.length ? writeResults.shift() : true;
  };
  response.end = () => { response.writableEnded = true; };
  response.destroy = () => response.emit("close");
  return response;
}

test("MCP response relay waits for downstream drain before writing more", async () => {
  const response = responseStub([false, true]);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      controller.enqueue(new TextEncoder().encode("second"));
      controller.close();
    },
  });

  const relay = relayResponseBody(body, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(response.writes, ["first"]);
  response.emit("drain");
  await relay;
  assert.deepEqual(response.writes, ["first", "second"]);
  assert.equal(response.writableEnded, true);
});

test("MCP response relay cancels its upstream when the client disconnects", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("pending")); },
    cancel() { cancelled = true; },
  });
  const response = responseStub([false]);

  const relay = relayResponseBody(body, response);
  await new Promise(resolve => setImmediate(resolve));
  response.emit("close");
  await relay;
  assert.equal(cancelled, true);
  assert.deepEqual(response.writes, ["pending"]);
  assert.equal(response.writableEnded, false);
});

test("MCP response relay cancels a stalled upstream read on disconnect", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const response = responseStub();

  const relay = relayResponseBody(body, response);
  await new Promise(resolve => setImmediate(resolve));
  response.emit("close");
  await relay;
  assert.equal(cancelled, true);
  assert.equal(response.writableEnded, false);
});
