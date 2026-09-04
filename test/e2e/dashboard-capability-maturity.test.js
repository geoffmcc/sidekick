"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { test, after } = require("node:test");

const root = path.resolve(__dirname, "../..");
let child;
let dataDir;
let port;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
}

function request(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers: {
      Authorization: `Basic ${Buffer.from("e2e-user:e2e-pass").toString("base64")}`,
      "Content-Type": "application/json",
    } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

async function waitForDashboard() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const result = await request("GET", "/api/capabilities");
      if (result.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("dashboard did not become ready within 30 seconds");
}

test("real Dashboard API returns evidence-bound maturity states", async () => {
  port = await freePort();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sidekick-e2e-"));
  child = spawn(process.execPath, ["src/dashboard.js"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", SIDEKICK_DATA_DIR: dataDir, SIDEKICK_DB_FILE: path.join(dataDir, "sidekick.db"), SIDEKICK_DASHBOARD_PORT: String(port), SIDEKICK_DASHBOARD_USER: "e2e-user", SIDEKICK_DASHBOARD_PASS: "e2e-pass", SIDEKICK_TOOL_POLICY: "open", SIDEKICK_APPROVAL_MODE: "off", SIDEKICK_SECRET_KEY: "e2e-dashboard-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForDashboard();
  const installed = await request("POST", "/api/capabilities/install", { name: "api-engineering", enable: true });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  const maturity = await request("GET", "/api/capabilities/api-engineering/maturity");
  assert.equal(maturity.status, 200);
  assert.equal(maturity.body.ok, true);
  assert.equal(maturity.body.maturity.pack_state, "enabled");
  assert.ok(["foundation", "operational", "integrated", "certified"].includes(maturity.body.maturity.level));
  assert.ok(Array.isArray(maturity.body.maturity.missing_checks));
  assert.match(maturity.body.maturity.next_action, /verification|health/i);
  const unknown = await request("GET", "/api/capabilities/does-not-exist/maturity");
  assert.equal(unknown.status, 400);
  assert.notEqual(unknown.body.error, "maturity unavailable");
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("close", resolve));
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});
