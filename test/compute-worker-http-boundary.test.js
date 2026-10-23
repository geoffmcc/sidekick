"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, test } = require("node:test");

let server;
let httpRequest;
let maxResponseBytes;

before(async () => {
  server = http.createServer((_req, res) => {
    if (_req.url === "/unicode-over-limit") {
      // 600,000 supplementary Unicode characters occupy 2.4 MB in UTF-8,
      // while JavaScript reports only 1.2 million UTF-16 code units.
      res.end(JSON.stringify({ value: "😀".repeat(600_000) }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.SIDEKICK_URL = `http://127.0.0.1:${server.address().port}`;
  ({ httpRequest, MAX_CONTROL_RESPONSE_BYTES: maxResponseBytes } = require("../src/compute/worker-agent"));
});

after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test("Compute worker accepts a bounded control response", async () => {
  const result = await httpRequest("GET", "/ok", null);
  assert.deepEqual(result, { status: 200, data: { ok: true } });
});

test("Compute worker bounds response bytes rather than UTF-16 characters", async () => {
  assert.equal(maxResponseBytes, 2 * 1024 * 1024);
  await assert.rejects(
    httpRequest("GET", "/unicode-over-limit", null),
    /Response too large/
  );
});
