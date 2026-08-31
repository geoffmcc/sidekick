"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-agent-health-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  SIDEKICK_DATA_DIR: dataDir,
  SIDEKICK_TOOL_POLICY: "open",
  SIDEKICK_APPROVAL_MODE: "off",
  SIDEKICK_DISABLE_OLLAMA_BOOTSTRAP: "1",
});

const agent = require("../src/agent");

function request(port) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: "/api/health" }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    }).on("error", reject);
  });
}

(async () => {
  const server = agent.app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const health = await request(server.address().port);
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
    assert.strictEqual(health.body.status, "healthy");
    assert.strictEqual(health.body.invariants.severity, "ok");
    console.log("Agent startup health passed");
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
