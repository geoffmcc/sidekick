"use strict";

const assert = require("assert");
const dns = require("node:dns");
const fs = require("fs");
const http = require("http");
const net = require("net");
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
const { createOwnerContext } = require("./helpers/authorized-context");
const { sidekick_web_fetch } = require("../src/tools/families/net-fetch");
const scopePolicy = require("../src/security/network-scope");
const authContext = createOwnerContext({ project: "network-fetch-test" });

(async () => {
  let receivedRequests = 0;
  const server = http.createServer((req, res) => {
    receivedRequests += 1;
    res.end(`scoped-fetch:${req.headers["x-trace"] || "none"}`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const scope = scopes.create({ name: "fetch_fixture", allowed_cidrs: ["127.0.0.0/8"], allowed_protocols: ["http"], allowed_ports: [port], allow_private_addresses: true }, "test-operator");
  try {
    const directCall = await require("../src/tools/context").runWithContext(authContext, () => sidekick_web_fetch({ url: `http://127.0.0.1:${port}/` }));
    assert.strictEqual(directCall.code, "canonical_dispatch_required", "raw handler calls must not bypass outbound policy or audit");
    const allowed = await callInternalTool("web_fetch", { url: `http://127.0.0.1:${port}/`, headers: JSON.stringify({ "X-Trace": "trace-1" }), network_scope: "fetch_fixture", network_scope_revision: scope.revision }, authContext);
    assert.match(allowed.content[0].text, /scoped-fetch:trace-1/, "bounded request policy preserves ordinary caller headers");
    const wsOnlyScope = scopes.create({ name: "fetch_ws_fixture", allowed_cidrs: ["127.0.0.0/8"], allowed_protocols: ["ws"], allowed_ports: [port], allow_private_addresses: true }, "test-operator");
    const beforeWsAttempt = receivedRequests;
    const wsAsHttp = await callInternalTool("web_fetch", { url: `ws://127.0.0.1:${port}/`, network_scope: "fetch_ws_fixture", network_scope_revision: wsOnlyScope.revision }, authContext);
    assert.strictEqual(wsAsHttp.isError, true, "web_fetch must reject WebSocket URLs even when an outbound scope permits ws");
    assert.strictEqual(receivedRequests, beforeWsAttempt, "a ws-only network grant must not authorize an ordinary HTTP request");
    const wssOnlyScope = scopes.create({ name: "fetch_wss_fixture", allowed_cidrs: ["127.0.0.0/8"], allowed_protocols: ["wss"], allowed_ports: [port], allow_private_addresses: true }, "test-operator");
    const wssAsHttp = await callInternalTool("web_fetch", { url: `wss://127.0.0.1:${port}/`, network_scope: "fetch_wss_fixture", network_scope_revision: wssOnlyScope.revision }, authContext);
    assert.strictEqual(wssAsHttp.isError, true, "web_fetch must reject secure WebSocket URLs even when an outbound scope permits wss");
    assert.strictEqual(receivedRequests, beforeWsAttempt, "a wss-only network grant must not authorize an ordinary HTTP request");
    const denied = await callInternalTool("web_fetch", { url: "http://169.254.169.254/", network_scope: "fetch_fixture", network_scope_revision: scope.revision }, authContext);
    assert.strictEqual(denied.isError, true);
    assert.match(denied.content[0].text, /network scope|permanent|denied/i);

    const originalLookup = dns.promises.lookup;
    const hostScope = scopePolicy.normalizeScope({ name: "dns_fixture", allowed_cidrs: ["93.184.216.0/24"], allowed_protocols: ["https"], allow_private_addresses: false });
    try {
      dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
      const allowedHost = await scopePolicy.resolveDestination(hostScope, "https://api.example.test/health");
      assert.strictEqual(allowedHost.ok, true);
      assert.strictEqual(allowedHost.dns, "validated_all");

      dns.promises.lookup = async () => { const error = new Error("fixture DNS failure"); error.code = "ENOTFOUND"; throw error; };
      const dnsFailure = await scopePolicy.resolveDestination(hostScope, "https://missing.example.test/");
      assert.strictEqual(dnsFailure.reason, "dns_resolution_failed");
      assert.strictEqual(dnsFailure.error_code, "ENOTFOUND");

      dns.promises.lookup = async () => [];
      const emptyDns = await scopePolicy.resolveDestination(hostScope, "https://empty.example.test/");
      assert.strictEqual(emptyDns.reason, "dns_no_results");

      dns.promises.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
      const refusedDns = await scopePolicy.resolveDestination(hostScope, "https://rebound.example.test/");
      assert.strictEqual(refusedDns.ok, false, "every DNS answer is checked against the scope");
      assert.strictEqual(refusedDns.dns, "refused");
    } finally {
      dns.promises.lookup = originalLookup;
    }

    const closedPortServer = net.createServer();
    await new Promise(resolve => closedPortServer.listen(0, "127.0.0.1", resolve));
    const closedPort = closedPortServer.address().port;
    await new Promise(resolve => closedPortServer.close(resolve));
    const closedScope = scopes.create({ name: "fetch_closed_fixture", allowed_cidrs: ["127.0.0.0/8"], allowed_protocols: ["http"], allowed_ports: [closedPort], allow_private_addresses: true }, "test-operator");
    const unreachable = await callInternalTool("web_fetch", { url: `http://127.0.0.1:${closedPort}/`, network_scope: "fetch_closed_fixture", network_scope_revision: closedScope.revision }, authContext);
    assert.ok(["service_unreachable", "network_unreachable"].includes(unreachable.code), `expected a bounded reachability classification, got ${unreachable.code}`);
    assert.ok(JSON.parse(unreachable.content[0].text).guidance, "unreachable fixture returns actionable guidance");

    let slowServer;
    try {
      slowServer = http.createServer(() => {});
      await new Promise(resolve => slowServer.listen(0, "127.0.0.1", resolve));
      const slowPort = slowServer.address().port;
      const slowScope = scopes.create({ name: "fetch_timeout_fixture", allowed_cidrs: ["127.0.0.0/8"], allowed_protocols: ["http"], allowed_ports: [slowPort], allow_private_addresses: true }, "test-operator");
      const timeout = await callInternalTool("web_fetch", { url: `http://127.0.0.1:${slowPort}/`, network_scope: "fetch_timeout_fixture", network_scope_revision: slowScope.revision }, { ...authContext, timeoutMs: 50 });
      assert.strictEqual(timeout.code, "timed_out_operation_may_continue", "dispatcher owns the deadline and reports if a timed-out operation may still be settling");
    } finally {
      if (slowServer?.listening) await new Promise(resolve => slowServer.close(resolve));
    }
    console.log("Named network scope web_fetch dispatcher test passed");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
