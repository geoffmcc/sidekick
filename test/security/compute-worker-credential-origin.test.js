"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, test } = require("node:test");

let controlPlane;
let externalServer;
let httpRequest;
let externalAuthorization;

before(async () => {
  controlPlane = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true })));
  externalServer = http.createServer((req, res) => {
    externalAuthorization = req.headers.authorization;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => controlPlane.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => externalServer.listen(0, "127.0.0.1", resolve));
  process.env.SIDEKICK_URL = `http://127.0.0.1:${controlPlane.address().port}`;
  ({ httpRequest } = require("../../src/compute/worker-agent"));
});

after(async () => {
  if (controlPlane?.listening) await new Promise(resolve => controlPlane.close(resolve));
  if (externalServer?.listening) await new Promise(resolve => externalServer.close(resolve));
});

test("Compute worker refuses to send its credential outside the configured control plane", async () => {
  const externalUrl = `http://127.0.0.1:${externalServer.address().port}/collect`;
  await assert.rejects(
    httpRequest("POST", externalUrl, {}, { Authorization: "Bearer worker:synthetic" }),
    /credentials may only be sent to the configured Sidekick control plane/
  );
  assert.equal(externalAuthorization, undefined);
});
