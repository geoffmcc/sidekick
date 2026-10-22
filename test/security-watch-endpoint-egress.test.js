"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { createEndpointProbe } = require("../src/security/endpoint-probe");
const { normalizeScope } = require("../src/security/network-scope");
const { createWatchScheduler } = require("../src/agent/watch-scheduler");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-watch-egress-"));
const ENV_KEYS = [
  "NODE_ENV", "SIDEKICK_DATA_DIR", "SIDEKICK_DB_FILE", "SIDEKICK_ALLOWED_PATHS",
  "SIDEKICK_APPROVAL_MODE", "SIDEKICK_TOOL_POLICY", "SIDEKICK_API_KEY",
  "SIDEKICK_AGENT_PROXY_KEY", "SIDEKICK_AGENT_SCHEDULER_KEY", "SIDEKICK_SECRET_KEY",
];
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
Object.assign(process.env, {
  NODE_ENV: "test",
  SIDEKICK_DATA_DIR: TEST_DATA_DIR,
  SIDEKICK_DB_FILE: path.join(TEST_DATA_DIR, "sidekick.db"),
  SIDEKICK_ALLOWED_PATHS: TEST_DATA_DIR,
  SIDEKICK_APPROVAL_MODE: "off",
  SIDEKICK_TOOL_POLICY: "open",
  SIDEKICK_API_KEY: "synthetic-watch-egress-api-key",
  SIDEKICK_AGENT_PROXY_KEY: "synthetic-watch-egress-proxy-key",
  SIDEKICK_AGENT_SCHEDULER_KEY: "synthetic-watch-egress-scheduler-key",
  SIDEKICK_SECRET_KEY: "synthetic-watch-egress-secret-key",
});
const networkScopes = require("../src/security/network-scopes");

let testDb = null;
after(() => {
  try { testDb?.getDb().close(); } catch {}
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("endpoint probes pin the resolved address and bind the network scope revision", async () => {
  let invocation = null;
  const probe = createEndpointProbe({
    resolve: async (target, label, options) => {
      invocation = { label, options };
      return { url: new URL(target), address: "203.0.113.9", family: 4 };
    },
    request: async (url, destination) => {
      invocation.url = url;
      invocation.destination = destination;
      return { status: 204, ok: true };
    },
  });

  const result = await probe.checkEndpoint("https://health.example.test:8443/probe?q=ok", "scope-a", 7);
  assert.deepEqual(result, { status: 204, ok: true });
  assert.equal(invocation.label, "endpoint");
  assert.deepEqual(invocation.options, { networkScope: "scope-a", networkScopeRevision: 7 });
  assert.equal(invocation.destination.address, "203.0.113.9");
  assert.equal(invocation.url.hostname, "health.example.test");
});

test("option-like targets and non-HTTP schemes are rejected before a request is opened", async () => {
  let requests = 0;
  const probe = createEndpointProbe({ request: () => { requests += 1; return { status: 200, ok: true }; } });
  await assert.rejects(probe.checkEndpoint("--config /etc/curlrc"), error => Boolean(error.code));
  await assert.rejects(probe.checkEndpoint("file:///etc/passwd"), error => Boolean(error.code));
  await assert.rejects(probe.checkEndpoint("http://user:password@example.test/"), error => Boolean(error.code));
  assert.equal(requests, 0);
});

test("private endpoint probes require a live named network scope and do not follow redirects", async () => {
  let localRequests = 0;
  let redirectRequests = 0;
  const redirectServer = http.createServer((_req, res) => {
    redirectRequests += 1;
    res.statusCode = 200;
    res.end("redirect target");
  });
  await new Promise(resolve => redirectServer.listen(0, "127.0.0.1", resolve));
  const redirectPort = redirectServer.address().port;

  const server = http.createServer((req, res) => {
    localRequests += 1;
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: `http://127.0.0.1:${redirectPort}/secret` });
      res.end();
      return;
    }
    res.statusCode = 204;
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const target = `http://127.0.0.1:${port}/health`;
  const scope = {
    ...normalizeScope({
      name: "watch-endpoint-test",
      allow_private_addresses: true,
      allowed_ips: ["127.0.0.1"],
      allowed_protocols: ["http"],
      allowed_ports: [port],
    }),
    scope_id: "synthetic-watch-endpoint-scope",
    revision: 1,
    is_current: true,
  };
  const probe = createEndpointProbe();

  try {
    await assert.rejects(probe.checkEndpoint(target), error => error.code === "network_scope_required");
    assert.equal(localRequests, 0, "a private target is denied before a socket is opened");
    const scopedResult = await probe.checkEndpoint(target, scope);
    assert.equal(scopedResult.status, 204);
    assert.equal(scopedResult.ok, true);
    assert.ok(scopedResult.elapsed_ms >= 0);

    const redirect = await probe.checkEndpoint(`http://127.0.0.1:${port}/redirect`, scope);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.ok, false);
    assert.equal(redirectRequests, 0, "redirects must not create an unvalidated second request");
  } finally {
    await Promise.all([
      new Promise(resolve => server.close(resolve)),
      new Promise(resolve => redirectServer.close(resolve)),
    ]);
  }
});

test("watch creation binds a private endpoint to the current scope revision and revocation stops it", async () => {
  const tools = require("../src/tools");
  const db = require("../src/db");
  testDb = db;
  tools.setSource("mcp");
  const TOOLS = require("./helpers/authorized-context").withOwnerToolContext(tools.TOOLS, { source: "mcp" });

  let requests = 0;
  const server = http.createServer((_req, res) => { requests += 1; res.statusCode = 200; res.end("ok"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const target = `http://127.0.0.1:${port}/health`;

  try {
    const netdiagWithoutScope = await TOOLS.netdiag({ action: "check", target });
    assert.equal(netdiagWithoutScope.isError, true);
    assert.equal(netdiagWithoutScope.code, "network_scope_required");
    assert.equal(requests, 0, "netdiag must apply endpoint scope before opening a private URL");

    const noScope = await TOOLS.watch({ action: "add", name: "private no scope", source: "endpoint", target, condition: "status=200" });
    assert.equal(noScope.isError, true);
    assert.equal(noScope.code, "network_scope_required");
    assert.equal(requests, 0);

    const scope = networkScopes.create({
      name: "watch-egress-scope",
      allow_private_addresses: true,
      allowed_ips: ["127.0.0.1"],
      allowed_protocols: ["http"],
      allowed_ports: [port],
    }, "test-operator");
    const scopedNetdiag = await TOOLS.netdiag({
      action: "check", target, network_scope: scope.name, network_scope_revision: scope.revision,
    });
    assert.equal(scopedNetdiag.isError, undefined, scopedNetdiag.content?.[0]?.text);
    assert.match(scopedNetdiag.content?.[0]?.text || "", /HTTP: 200/);
    assert.match(scopedNetdiag.content?.[0]?.text || "", /Ping: Not run for URL target/);
    assert.match(scopedNetdiag.content?.[0]?.text || "", /SSH \(22\): Not run for URL target/);
    assert.equal(requests, 1, "scoped netdiag sends only its single governed HTTP request");

    const added = await TOOLS.watch({
      action: "add", name: "private scoped endpoint", source: "endpoint", target,
      condition: "status=200", network_scope: scope.name,
    });
    assert.equal(added.isError, undefined, added.content?.[0]?.text);
    const watch = tools.loadWatches()[0];
    assert.equal(watch.network_scope, scope.name);
    assert.equal(watch.network_scope_revision, scope.revision);
    assert.equal(requests, 1, "creating a watch validates policy without opening the endpoint");

    networkScopes.update(scope.scope_id, {
      allow_private_addresses: true,
      allowed_ips: ["127.0.0.1"],
      allowed_protocols: ["http"],
      allowed_ports: [port + 1],
    }, "test-operator");
    const checked = await TOOLS.watch({ action: "check", id: watch.id });
    assert.equal(checked.isError, true);
    assert.equal(checked.code, "network_scope_denied");
    assert.equal(requests, 1, "a revised scope invalidates the stored watch before the socket opens");
    const failedCheck = db.getDb().prepare("SELECT state, result_status FROM platform_executions WHERE parent_execution_id = ? AND operation_type = 'watch_check' ORDER BY started_at DESC LIMIT 1").get(watch.platform_execution_id);
    assert.equal(failedCheck.state, "failed");
    assert.equal(failedCheck.result_status, "failure");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("scheduled endpoint policy denial is audited and never dispatches its action", async () => {
  const watch = {
    id: "watch-private",
    name: "private endpoint",
    source: "endpoint",
    target: "http://10.0.0.8/health",
    network_scope: "revoked-scope",
    network_scope_revision: 3,
    condition: "status!=200",
    status: "active",
    platform_execution_id: "watch-definition-execution",
  };
  const events = [];
  const transitions = [];
  let actionCalls = 0;
  const scheduler = createWatchScheduler({
    loadWatches: () => [watch],
    saveWatches: () => {},
    claimScheduledDefinition: () => ({ ok: true, claim: null }),
    pauseWatchForCancel: () => {},
    startScheduledLeaseRenewal: () => null,
    releaseScheduledClaim: () => {},
    createScheduledPlatformExecution: (_kind, _watch, options) => ({ execution_id: options.operationType === "watch_check" ? "watch-check-execution" : "watch-execution" }),
    appendScheduledPlatformEvent: (...args) => events.push(args),
    transitionExecution: (...args) => transitions.push(args),
    executeWatchAction: async () => { actionCalls += 1; },
    checkService: () => ({}),
    checkProcess: () => ({}),
    checkEndpoint: async (_target, scope, revision) => {
      assert.equal(scope, "revoked-scope");
      assert.equal(revision, 3);
      const error = new Error("denied");
      error.code = "network_scope_unavailable";
      error.policyDenied = true;
      throw error;
    },
    checkFile: () => ({}),
    evaluateWatchCondition: () => true,
    processId: 42,
  });

  await scheduler.checkWatch(watch);
  assert.equal(actionCalls, 0);
  assert.equal(transitions[0][0], "watch-check-execution");
  assert.equal(transitions[0][1], "failed");
  assert.equal(events.some(event => event[2] === "schedule.watch.check_failed"), true);
});
