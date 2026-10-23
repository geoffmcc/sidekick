"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-ollama-egress-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "ollama-egress-test-secret";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
require("../src/db").runPendingMigrations();

const { callInternalTool } = require("../src/tools/dispatcher");
const { createOwnerContext } = require("./helpers/authorized-context");
const context = createOwnerContext({ project: "ollama-egress-test" });

after(() => {
  try { require("../src/db").getDb().close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Ollama management uses the bounded provider client and does not follow redirects", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === "/api/tags") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "fixture-model", size: 10, digest: "1234567890123456", modified_at: "now" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await callInternalTool("ollama", { action: "list" }, context);
    assert.equal(result.isError, true, "redirect response should fail JSON decoding rather than be followed");
    assert.equal(requests, 1, "only the configured endpoint should receive a request");
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test("Ollama management still handles a valid configured local provider", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/api/tags");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "fixture-model", size: 10, digest: "1234567890123456", modified_at: "now" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await callInternalTool("ollama", { action: "list" }, context);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /fixture-model/);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test("Ollama management socket timeout respects the caller's tool deadline", async () => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  try {
    const result = await callInternalTool("ollama", { action: "list" }, { ...context, timeoutMs: 200 });
    assert.equal(result.isError, true);
    assert.ok(Date.now() - started < 1500, "the provider socket should not outlive the caller deadline by more than the test tolerance");
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = previous;
    await new Promise(resolve => server.close(resolve));
  }
});
