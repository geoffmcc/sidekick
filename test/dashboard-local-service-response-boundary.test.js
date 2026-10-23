"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, test } = require("node:test");
const {
  getJsonFromLocalService,
  MAX_LOCAL_SERVICE_RESPONSE_BYTES,
} = require("../src/dashboard/local-service-client");

let server;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/oversized") {
      res.end(JSON.stringify({ value: "😀".repeat(70_000) }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test("dashboard local-service client accepts bounded JSON", async () => {
  assert.deepEqual(await getJsonFromLocalService(port, "/ok"), { ok: true });
});

test("dashboard local-service client bounds UTF-8 response bytes", async () => {
  assert.equal(MAX_LOCAL_SERVICE_RESPONSE_BYTES, 256 * 1024);
  await assert.rejects(
    getJsonFromLocalService(port, "/oversized"),
    /response exceeds the size bound/
  );
});
