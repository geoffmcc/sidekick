"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright-core");
const { browserConfig } = require("../../src/browser/config");
const browserDriver = require("../../src/browser/driver");

const root = path.resolve(__dirname, "../..");
const dashboardUser = "e2e-user";
const dashboardPassword = "e2e-dashboard-password";
const secretKey = "e2e-dashboard-secret-key";

function bounded(value, limit = 4000) {
  return String(value || "").slice(-limit);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function basicAuth() {
  return `Basic ${Buffer.from(`${dashboardUser}:${dashboardPassword}`).toString("base64")}`;
}

function request(port, method, requestPath, body, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (options.auth !== false) headers.Authorization = basicAuth();
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined && body !== null) req.end(JSON.stringify(body));
    else req.end();
  });
}

async function waitFor(label, check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : ""}`);
}

function serviceEnvironment({ dataDir, dashboardPort, agentPort, mcpPort, ollamaUrl, withAgent }) {
  const env = { ...process.env };
  for (const key of ["OLLAMA_URL", "OLLAMA_MODEL", "GROQ_API_KEY", "OPENAI_API_KEY", "SIDEKICK_DISABLE_OLLAMA_BOOTSTRAP", "SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP"]) delete env[key];
  Object.assign(env, {
    NODE_ENV: "test",
    SIDEKICK_DATA_DIR: dataDir,
    SIDEKICK_DB_FILE: path.join(dataDir, "sidekick.db"),
    SIDEKICK_DASHBOARD_PORT: String(dashboardPort),
    SIDEKICK_DASHBOARD_BIND_HOST: "127.0.0.1",
    SIDEKICK_DASHBOARD_USER: dashboardUser,
    SIDEKICK_DASHBOARD_PASS: dashboardPassword,
    SIDEKICK_SECRET_KEY: secretKey,
    SIDEKICK_PORT: String(mcpPort),
    SIDEKICK_AGENT_PORT: String(agentPort),
    SIDEKICK_TOOL_POLICY: "open",
    SIDEKICK_APPROVAL_MODE: "off",
    SIDEKICK_DISABLE_BROWSER: "1",
  });
  if (withAgent) {
    env.OLLAMA_URL = ollamaUrl;
    env.OLLAMA_MODEL = "e2e-model";
    env.SIDEKICK_DISABLE_OLLAMA_BOOTSTRAP = "0";
  } else {
    env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";
  }
  return env;
}

function startProcess(command, args, env, output) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output.stdout = bounded(output.stdout + chunk); });
  child.stderr.on("data", chunk => { output.stderr = bounded(output.stderr + chunk); });
  child.once("exit", code => { output.exit = code; });
  return child;
}

async function startOllamaBoundary() {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", chunk => { text += chunk; });
    req.on("end", () => {
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch {}
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/api/tags") {
        res.end(JSON.stringify({ models: [{ name: "e2e-model", size: 1, details: { parameter_size: "test" } }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/chat") {
        const content = body.format === "json" ? JSON.stringify({ done: true, result: "E2E task completed" }) : "E2E direct answer";
        res.end(JSON.stringify({ model: "e2e-model", message: { role: "assistant", content }, done: true, done_reason: "stop" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "boundary route not found" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, port };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function launchDashboard(fixture) {
  const env = serviceEnvironment({
    ...fixture,
    ollamaUrl: fixture.ollama ? `http://127.0.0.1:${fixture.ollama.port}` : undefined,
  });
  fixture.dashboardOutput = { stdout: "", stderr: "", exit: null };
  fixture.dashboard = startProcess(process.execPath, ["src/dashboard.js"], env, fixture.dashboardOutput);
  await waitFor("Dashboard", async () => {
    if (fixture.dashboardOutput.exit !== null) throw new Error(`exit=${fixture.dashboardOutput.exit}`);
    const result = await request(fixture.dashboardPort, "GET", "/api/capabilities");
    return result.status === 200;
  });
}

async function launchAgent(fixture) {
  const env = serviceEnvironment({
    ...fixture,
    ollamaUrl: fixture.ollama ? `http://127.0.0.1:${fixture.ollama.port}` : undefined,
  });
  fixture.agentOutput = { stdout: "", stderr: "", exit: null };
  fixture.agent = startProcess(process.execPath, ["src/agent.js"], env, fixture.agentOutput);
  await waitFor("Agent", async () => {
    if (fixture.agentOutput.exit !== null) throw new Error(`exit=${fixture.agentOutput.exit}`);
    const result = await request(fixture.agentPort, "GET", "/api/health", null, { auth: false });
    return result.status === 200;
  });
}

async function startFixture({ withAgent = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sidekick-dashboard-e2e-"));
  const [dashboardPort, agentPort, mcpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const fixture = {
    dataDir,
    dashboardPort,
    agentPort,
    mcpPort,
    withAgent,
    dashboard: null,
    agent: null,
    dashboardOutput: null,
    agentOutput: null,
    ollama: null,
    baseUrl: `http://127.0.0.1:${dashboardPort}`,
  };
  if (withAgent) fixture.ollama = await startOllamaBoundary();
  if (withAgent) await launchAgent(fixture);
  await launchDashboard(fixture);
  if (withAgent) {
    await waitFor("Compute provider backed by the local inference boundary", async () => {
      const result = await request(fixture.dashboardPort, "GET", "/api/compute");
      return result.status === 200 && result.body?.overview?.providers?.healthy > 0;
    });
  }
  fixture.request = (method, requestPath, body, options) => request(fixture.dashboardPort, method, requestPath, body, options);
  fixture.restartDashboard = async () => {
    await stopProcess(fixture.dashboard);
    await launchDashboard(fixture);
  };
  fixture.close = async () => {
    await stopProcess(fixture.dashboard);
    await stopProcess(fixture.agent);
    if (fixture.ollama) await new Promise(resolve => fixture.ollama.server.close(() => resolve()));
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  };
  return fixture;
}

async function launchBrowser() {
  const executable = browserDriver.resolveExecutable(browserConfig()).executable;
  if (!executable) throw new Error("the required E2E browser runtime is unavailable");
  return chromium.launch({ headless: true, executablePath: executable });
}

async function withDiagnostics(page, fixture, label, fn) {
  try {
    return await fn();
  } catch (error) {
    const diagnostics = [`E2E failure: ${label}`, `url: ${page.url()}`];
    try { diagnostics.push(`title: ${await page.title()}`); } catch {}
    try { diagnostics.push(`page text:\n${bounded(await page.locator("body").innerText(), 3000)}`); } catch {}
    try {
      const screenshot = path.join(fixture.dataDir, `${label.replace(/[^a-z0-9]+/gi, "-")}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      diagnostics.push(`screenshot: ${screenshot}`);
    } catch (screenshotError) {
      diagnostics.push(`screenshot unavailable: ${screenshotError.message}`);
    }
    diagnostics.push(`dashboard stdout:\n${bounded(fixture.dashboardOutput?.stdout)}`);
    diagnostics.push(`dashboard stderr:\n${bounded(fixture.dashboardOutput?.stderr)}`);
    if (fixture.agentOutput) diagnostics.push(`agent stderr:\n${bounded(fixture.agentOutput.stderr)}`);
    throw new Error(`${error.message}\n${diagnostics.join("\n")}`, { cause: error });
  }
}

module.exports = {
  dashboardUser,
  dashboardPassword,
  startFixture,
  launchBrowser,
  waitFor,
  withDiagnostics,
};
