"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const dns = require("node:dns");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-influx-egress-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_INFLUX_ALLOWED_HOSTS = "metrics.example.test";
const { requestInflux } = require("../src/tools/families/observability");

test("Influx requests pin the allowlisted hostname and do not follow redirects", async t => {
  const originalLookup = dns.promises.lookup;
  const lookupCalls = [];
  dns.promises.lookup = async hostname => {
    lookupCalls.push(hostname);
    return [{ address: "127.0.0.1", family: 4 }];
  };
  t.after(() => {
    dns.promises.lookup = originalLookup;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.headers.host, `metrics.example.test:${server.address().port}`);
    assert.equal(req.headers.authorization, "Token synthetic-influx-token");
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await requestInflux(`http://metrics.example.test:${server.address().port}/api/v2/query`, {
    method: "POST",
    headers: { Authorization: "Token synthetic-influx-token" },
    body: "query=synthetic",
  });
  assert.equal(response.status, 302);
  await response.body?.cancel();
  assert.equal(requests, 1, "redirect destinations must not receive a request");
  assert.deepEqual(lookupCalls, ["metrics.example.test"]);
});

test("Influx requests refuse a protected address in any DNS answer", async t => {
  const originalLookup = dns.promises.lookup;
  let requests = 0;
  const server = http.createServer(() => { requests++; });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  dns.promises.lookup = async () => [
    { address: "127.0.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ];
  t.after(() => {
    dns.promises.lookup = originalLookup;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(
    requestInflux(`http://metrics.example.test:${server.address().port}/api/v2/query`),
    /protected link-local or metadata endpoint/,
  );
  assert.equal(requests, 0);
});
