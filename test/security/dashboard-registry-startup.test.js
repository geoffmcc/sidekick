"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const dataDir = process.env.SIDEKICK_TEST_DATA_DIR;
const dbFile = process.env.SIDEKICK_TEST_DB_FILE;
const dashboardPort = Number(process.env.SIDEKICK_TEST_PORT);
assert.ok(dataDir, "test runner must provide an isolated data directory");
assert.ok(dbFile, "test runner must provide an isolated database file");
assert.ok(Number.isInteger(dashboardPort) && dashboardPort > 0, "test runner must provide an isolated loopback port");

Object.assign(process.env, {
  NODE_ENV: "test",
  SIDEKICK_DATA_DIR: dataDir,
  SIDEKICK_DB_FILE: dbFile,
  SIDEKICK_TOOL_POLICY: "open",
  SIDEKICK_APPROVAL_MODE: "off",
  SIDEKICK_DASHBOARD_PORT: String(dashboardPort),
  SIDEKICK_DASHBOARD_BIND_HOST: "127.0.0.1",
  SIDEKICK_DASHBOARD_USER: "security-registry-test",
  SIDEKICK_DASHBOARD_PASS: "synthetic-dashboard-password",
  SIDEKICK_API_KEY: "sk-security-registry-test",
  SIDEKICK_AGENT_PROXY_KEY: "sk-security-registry-test-agent-proxy",
  SIDEKICK_SECRET_KEY: "security-registry-test-secret-key",
  SIDEKICK_DISABLE_BROWSER: "1",
});

function get(pathname) {
  return new Promise((resolve, reject) => {
    const authorization = `Basic ${Buffer.from("security-registry-test:synthetic-dashboard-password").toString("base64")}`;
    const request = http.get({ hostname: "127.0.0.1", port: dashboardPort, path: pathname, headers: { Authorization: authorization }, agent: false }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.setTimeout(1000, () => request.destroy(new Error("dashboard readiness request timed out")));
    request.once("error", reject);
  });
}

async function waitForDashboard(child, output, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Dashboard exited (${child.exitCode}): ${output()}`);
    try {
      if (await get("/api/capabilities") === 200) return;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Dashboard did not become ready: ${lastError}\n${output()}`);
}

test("Dashboard startup does not deprecate pack tools in the shared registry", async t => {
  const dbStore = require("../../src/db");
  dbStore.runPendingMigrations();
  const bundled = require("../../src/packs/bundled");
  const installed = bundled.installBundledPack("jellyfin", { enable: true });
  assert.equal(installed.pack.state, "enabled");

  const modules = require("../../src/modules/builtin-modules");
  modules.provisionBuiltinModules();
  const tools = require("../../src/tools");
  tools.syncToolRegistry();
  const before = dbStore.getDb().prepare("SELECT enabled, deprecated FROM tools WHERE name = 'jellyfin'").get();
  assert.deepEqual(before, { enabled: 1, deprecated: 0 }, "fixture must model the MCP process having synced the active pack");

  let captured = "";
  const child = spawn(process.execPath, ["src/dashboard.js"], {
    cwd: path.resolve(__dirname, "../.."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { captured = (captured + chunk).slice(-8000); });
  child.stderr.on("data", chunk => { captured = (captured + chunk).slice(-8000); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    try { dbStore.closeDatabase(); } catch {}
  });

  await waitForDashboard(child, () => captured);
  const tool = dbStore.getDb().prepare("SELECT enabled, deprecated FROM tools WHERE name = 'jellyfin'").get();
  assert.deepEqual(tool, { enabled: 1, deprecated: 0 }, "Dashboard startup must retain a live module's discoverable registry record");

  const compat = require("../../src/tools").getToolDefsForSource("agent");
  assert.ok(compat.some(definition => definition.name === "jellyfin" && definition.enabled), "Agent discovery must include the healthy pack tool");
});
