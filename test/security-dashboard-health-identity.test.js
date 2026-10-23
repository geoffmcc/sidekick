"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname, headers, timeout: 8000 }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    req.once("timeout", () => req.destroy(new Error("Dashboard summary request timed out")));
    req.once("error", reject);
  });
}

test("Dashboard summary forwards its live authenticated identity to MCP health", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-mcp-identity-"));
  const dashboardPort = await reserveLoopbackPort();
  let capturedAuthorization = null;
  let capturedIdentity = null;
  let dashboardServer = null;

  process.env.NODE_ENV = "test";
  process.env.SIDEKICK_DATA_DIR = dataDir;
  process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
  process.env.SIDEKICK_DASHBOARD_PORT = String(dashboardPort);
  process.env.SIDEKICK_DASHBOARD_BIND_HOST = "127.0.0.1";
  process.env.SIDEKICK_DASHBOARD_USER = "health-owner";
  process.env.SIDEKICK_DASHBOARD_PASS = "synthetic-health-test-password";
  process.env.SIDEKICK_DASHBOARD_TRUST_PROXY = "true";
  process.env.SIDEKICK_API_KEY = "synthetic-global-mcp-key-not-for-dashboard";
  process.env.SIDEKICK_AGENT_PROXY_KEY = "synthetic-dashboard-agent-proxy-key";
  process.env.SIDEKICK_TOOL_POLICY = "open";
  process.env.SIDEKICK_APPROVAL_MODE = "off";

  const mcpServer = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    capturedAuthorization = req.headers.authorization || null;
    const token = /^Bearer\s+(.+)$/i.exec(capturedAuthorization || "")?.[1] || null;
    const authentication = require("../src/core/authentication");
    const authorization = require("../src/core/authorization");
    capturedIdentity = authentication.authenticateBearerIdentity(token);
    const decision = capturedIdentity && authorization.authorize({
      principalId: capturedIdentity.principal_id,
      permission: "dashboard.operations.read",
      credentialScopes: capturedIdentity.scopes,
    });
    if (!decision?.ok) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthenticated" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      sessions: 9,
      staleMappings: 0,
      sessionDetails: [{ id: "synthetic-mcp-session-detail" }],
    }));
  });
  await listen(mcpServer, await reserveLoopbackPort());
  process.env.SIDEKICK_PORT = String(mcpServer.address().port);

  t.after(async () => {
    await close(dashboardServer);
    await close(mcpServer);
    try { require("../src/db").closeDatabase(); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let resolveDashboardListening;
  const dashboardListening = new Promise(resolve => { resolveDashboardListening = resolve; });
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function(...args) {
    const result = originalListen.apply(this, args);
    if (!dashboardServer) {
      dashboardServer = this;
      if (dashboardServer.listening) resolveDashboardListening();
      else dashboardServer.once("listening", resolveDashboardListening);
    }
    return result;
  };
  try {
    require("../src/dashboard");
  } finally {
    http.Server.prototype.listen = originalListen;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Dashboard server did not start")), 10000);
    dashboardListening.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });

  const response = await request(dashboardPort, "/api/dashboard-summary", {
    authorization: `Basic ${Buffer.from("health-owner:synthetic-health-test-password").toString("base64")}`,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.sessions.mcpClients, 9, "Dashboard consumes diagnostics returned only to an authorized MCP principal");
  assert.equal(response.body.sessions.mcpSessionDetails[0].id, "synthetic-mcp-session-detail");
  assert.equal(capturedIdentity?.authentication_method, "browser_session");
  assert.equal(capturedIdentity?.principal_type, "human");
  assert.match(capturedAuthorization || "", /^Bearer\s+/);
  assert.notEqual(capturedAuthorization, `Bearer ${process.env.SIDEKICK_API_KEY}`, "Dashboard must not forward the global MCP key");
});
