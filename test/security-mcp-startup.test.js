"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readinessAddress, readinessUrl, waitForHttpReady } = require("../scripts/wait-for-mcp-ready");

test("MCP readiness probe uses a local health URL for wildcard binds", () => {
  assert.equal(readinessAddress("0.0.0.0"), "127.0.0.1");
  assert.equal(readinessAddress("::"), "::1");
  assert.equal(readinessUrl("0.0.0.0", "4097"), "http://127.0.0.1:4097/health");
  assert.equal(readinessUrl("::1", "4097"), "http://[::1]:4097/health");
  assert.throws(() => readinessUrl("127.0.0.1", "0"), /valid TCP port/);
});

test("MCP readiness probe waits through unavailable responses and succeeds on health", async () => {
  let time = 0;
  let probes = 0;
  const result = await waitForHttpReady({
    url: "http://127.0.0.1:4097/health",
    timeoutMs: 2000,
    retryIntervalMs: 100,
    fetchImpl: async () => ({ ok: ++probes >= 3 }),
    now: () => time,
    sleep: async duration => { time += duration; },
  });
  assert.equal(result.ready, true);
  assert.equal(probes, 3);
});

test("MCP readiness probe fails after its bounded startup deadline", async () => {
  let time = 0;
  const result = await waitForHttpReady({
    url: "http://127.0.0.1:4097/health",
    timeoutMs: 250,
    retryIntervalMs: 100,
    fetchImpl: async () => { throw new Error("not listening"); },
    now: () => time,
    sleep: async duration => { time += duration; },
  });
  assert.deepEqual(result, { ready: false, url: "http://127.0.0.1:4097/health", timeoutMs: 250 });
});
