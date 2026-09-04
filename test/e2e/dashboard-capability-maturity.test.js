"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { test, after } = require("node:test");
const { chromium } = require("playwright-core");
const { browserConfig } = require("../../src/browser/config");
const browserDriver = require("../../src/browser/driver");

const root = path.resolve(__dirname, "../..");
let child;
let dataDir;
let port;
let childStdout = "";
let childStderr = "";
let childExit = null;
const dashboardPassword = ["e2e", "dashboard", "password"].join("-");
const mcpApiKey = ["e2e", "mcp", "api", "key"].join("-");
const dashboardSecretKey = ["e2e", "dashboard", "secret"].join("-");

function bounded(value) {
  return String(value || "").slice(-4000);
}

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
      Authorization: `Basic ${Buffer.from(`e2e-user:${dashboardPassword}`).toString("base64")}`,
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
    if (childExit !== null) throw new Error(`dashboard exited during startup (exit=${childExit})\nstdout:\n${bounded(childStdout)}\nstderr:\n${bounded(childStderr)}`);
    try {
      const result = await request("GET", "/api/capabilities");
      if (result.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`dashboard did not become ready within 30 seconds (exit=${childExit ?? "running"})\nstdout:\n${bounded(childStdout)}\nstderr:\n${bounded(childStderr)}`);
}

test("real Dashboard API returns evidence-bound maturity states", async () => {
  port = await freePort();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sidekick-e2e-"));
  child = spawn(process.execPath, ["src/dashboard.js"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", SIDEKICK_DATA_DIR: dataDir, SIDEKICK_DB_FILE: path.join(dataDir, "sidekick.db"), SIDEKICK_DASHBOARD_PORT: String(port), SIDEKICK_DASHBOARD_USER: "e2e-user", SIDEKICK_DASHBOARD_PASS: dashboardPassword, SIDEKICK_API_KEY: mcpApiKey, SIDEKICK_TOOL_POLICY: "open", SIDEKICK_APPROVAL_MODE: "off", SIDEKICK_SECRET_KEY: dashboardSecretKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { childStdout = bounded(childStdout + chunk); });
  child.stderr.on("data", chunk => { childStderr = bounded(childStderr + chunk); });
  child.once("exit", code => { childExit = code; });
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

  const executable = browserDriver.resolveExecutable(browserConfig()).executable;
  assert.ok(executable, "the required E2E browser runtime is unavailable");
  const browser = await chromium.launch({ headless: true, executablePath: executable });
  try {
    const page = await browser.newPage({ httpCredentials: { username: "e2e-user", password: dashboardPassword } });
    await page.goto(`http://127.0.0.1:${port}/#mission`, { waitUntil: "networkidle" });
    await page.locator("#nav-capabilities").click();
    const maturityButton = page.locator('button[aria-label*="Show maturity"]');
    try {
      await maturityButton.first().waitFor({ state: "visible", timeout: 10000 });
    } catch (error) {
      throw new Error(`${error.message}\ncapabilities text:\n${bounded(await page.locator("#capInstalled").textContent())}\npage text:\n${bounded(await page.locator("body").textContent())}`);
    }
    await maturityButton.focus();
    await maturityButton.press("Enter");
    const detail = page.locator("#capDetail-api-engineering");
    await detail.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#capDetail-api-engineering")?.textContent.includes('"level"'));
    assert.match(await detail.textContent(), /"level":\s*"(?:foundation|operational|integrated|certified)"/);
    assert.doesNotMatch(await detail.textContent(), /maturity unavailable/);
    assert.equal(await maturityButton.getAttribute("aria-busy"), null);

    await maturityButton.click();
    await maturityButton.click();
    await page.waitForFunction(() => document.querySelector("#capDetail-api-engineering")?.textContent.includes('"missing_checks"'));
    assert.match(await detail.textContent(), /missing_checks/);

    await page.route(`**/api/capabilities/api-engineering/maturity`, async route => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, code: "internal_failure", error: "sanitized maturity failure" }) });
    });
    await maturityButton.click();
    await page.waitForFunction(() => document.querySelector("#capDetail-api-engineering")?.textContent.includes("Maturity error:"));
    assert.match(await detail.textContent(), /sanitized maturity failure/);
    assert.doesNotMatch(await page.locator("#capError").textContent(), new RegExp(`internal stack|${dashboardSecretKey}`));
    await page.unroute(`**/api/capabilities/api-engineering/maturity`);
  } finally {
    await browser.close();
  }
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
