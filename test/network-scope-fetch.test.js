"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-network-fetch-"));
process.env.SIDEKICK_DATA_DIR = dir;
process.env.SIDEKICK_DB_FILE = path.join(dir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "network-fetch-test-secret";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
require("../src/db").runPendingMigrations();
const scopes = require("../src/security/network-scopes");
const { callInternalTool } = require("../src/tools/dispatcher");

(async () => {
  const server = http.createServer((_req, res) => res.end("scoped-fetch"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const scope = scopes.create({ name: "fetch_fixture", allowed_cidrs: ["127.0.0.0/8"], allowed_protocols: ["http"], allowed_ports: [port], allow_private_addresses: true }, "test-operator");
  try {
    const allowed = await callInternalTool("web_fetch", { url: `http://127.0.0.1:${port}/`, network_scope: "fetch_fixture", network_scope_revision: scope.revision });
    assert.match(allowed.content[0].text, /scoped-fetch/);
    const denied = await callInternalTool("web_fetch", { url: "http://169.254.169.254/", network_scope: "fetch_fixture", network_scope_revision: scope.revision });
    assert.strictEqual(denied.isError, true);
    assert.match(denied.content[0].text, /network scope|permanent|denied/i);
    console.log("Named network scope web_fetch dispatcher test passed");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
