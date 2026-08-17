"use strict";

// Governed Browser Automation — egress and policy unit/security tests.
//
// No browser is launched: this suite proves the egress boundary, config
// clamping, driver resolution, secret scrubbing and artifact custody logic
// deterministically, and runs the per-session proxy against real local HTTP
// servers. It is the always-on security floor; browser-subsystem.test.js adds
// the real-Chromium end-to-end proof on top.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-browser-egress-"));
process.env.SIDEKICK_DATA_DIR = DATA_DIR;

const egress = require("../src/browser/egress");
const { browserConfig } = require("../src/browser/config");
const sessionsStore = require("../src/browser/sessions");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); })
    .catch((error) => { failed += 1; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${error.stack || error.message}`); });
}

const OPEN = egress.buildSessionPolicy({ allowPrivateNetwork: true }, { allowPrivateNetwork: true });
const CLOSED = egress.buildSessionPolicy({ allowPrivateNetwork: false }, { allowPrivateNetwork: false });

(async () => {
  console.log("\nGoverned Browser Automation — egress & policy\n");

  // --- URL-text policy -----------------------------------------------------

  await test("metadata endpoint is always refused, even with private allowed", () => {
    assert.ok(egress.evaluateBrowserUrl("http://169.254.169.254/latest/meta-data/", OPEN));
    assert.ok(egress.evaluateHost("169.254.169.254", OPEN), "link-local must be refused under an open policy too");
  });

  await test("private/loopback refused without opt-in, allowed with it", () => {
    assert.ok(egress.evaluateBrowserUrl("http://127.0.0.1:8080/", CLOSED), "loopback should be refused");
    assert.ok(egress.evaluateBrowserUrl("http://10.0.0.5/", CLOSED), "RFC1918 should be refused");
    assert.strictEqual(egress.evaluateBrowserUrl("http://127.0.0.1:8080/", OPEN), null, "loopback allowed with opt-in");
  });

  await test("localhost hostname is treated as loopback", () => {
    assert.ok(egress.evaluateBrowserUrl("http://localhost:3000/", CLOSED));
    assert.ok(egress.evaluateBrowserUrl("http://foo.localhost/", CLOSED));
  });

  await test("non-http(s) schemes are refused (no file:, no data:)", () => {
    assert.ok(egress.evaluateBrowserUrl("file:///etc/passwd", OPEN));
    assert.ok(egress.evaluateBrowserUrl("data:text/html,<h1>x</h1>", OPEN));
    assert.ok(egress.evaluateBrowserUrl("chrome://settings", OPEN));
    assert.ok(egress.evaluateBrowserUrl("ftp://example.com/", OPEN));
  });

  await test("embedded credentials in the URL are refused", () => {
    assert.ok(egress.evaluateBrowserUrl("http://user:pass@example.com/", OPEN));
  });

  await test("IPv4-mapped IPv6 cannot launder a private v4 address", () => {
    assert.ok(egress.evaluateHost("::ffff:127.0.0.1", CLOSED), "mapped loopback must be refused");
    assert.ok(egress.evaluateHost("::ffff:10.0.0.1", CLOSED), "mapped RFC1918 must be refused");
  });

  await test("allowed_hosts narrows policy and never widens it", () => {
    const scoped = egress.buildSessionPolicy({ allowedHosts: ["example.com", "*.trusted.org"], allowPrivateNetwork: true }, { allowPrivateNetwork: true });
    assert.strictEqual(egress.evaluateBrowserUrl("https://example.com/", scoped), null);
    assert.strictEqual(egress.evaluateBrowserUrl("https://api.trusted.org/", scoped), null);
    assert.ok(egress.evaluateBrowserUrl("https://evil.com/", scoped), "off-list host refused");
    // Even with private allowed AND host listed, the wildcard cannot re-enable
    // a metadata host.
    const withMeta = egress.buildSessionPolicy({ allowedHosts: ["169.254.169.254"], allowPrivateNetwork: true }, { allowPrivateNetwork: true });
    assert.ok(egress.evaluateBrowserUrl("http://169.254.169.254/", withMeta), "metadata stays refused even if listed");
  });

  await test("wildcard host patterns match subdomains but not the bare/other domains", () => {
    assert.ok(egress.matchHostPattern("api.example.com", "*.example.com"));
    assert.ok(!egress.matchHostPattern("example.com", "*.example.com"));
    assert.ok(!egress.matchHostPattern("notexample.com", "*.example.com"));
  });

  // --- DNS resolution + pinning -------------------------------------------

  await test("resolveAndValidate refuses a hostname that resolves to loopback (rebinding)", async () => {
    // localhost resolves to 127.0.0.1; under a closed policy that must fail even
    // though the NAME itself is not a literal private IP.
    const result = await egress.resolveAndValidate("localhost", CLOSED);
    assert.ok(result.refusal, "localhost resolution should be refused under closed policy");
  });

  await test("resolveAndValidate pins a public IP literal", async () => {
    const result = await egress.resolveAndValidate("93.184.216.34", OPEN);
    assert.strictEqual(result.address, "93.184.216.34");
  });

  // --- Live proxy enforcement ---------------------------------------------

  await test("session proxy blocks a CONNECT to a forbidden host", async () => {
    const blocked = [];
    const proxy = await egress.createSessionProxy(CLOSED, { onBlocked: (r) => blocked.push(r) });
    try {
      const status = await new Promise((resolve, reject) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write("CONNECT 10.0.0.9:443 HTTP/1.1\r\nHost: 10.0.0.9:443\r\n\r\n");
        });
        let buf = "";
        socket.on("data", (d) => { buf += d; if (buf.includes("\r\n")) { resolve(buf.split("\r\n")[0]); socket.destroy(); } });
        socket.on("error", reject);
      });
      assert.ok(status.includes("403"), `expected 403, got: ${status}`);
      assert.strictEqual(blocked.length, 1);
      assert.strictEqual(blocked[0].kind, "connect");
    } finally {
      await proxy.close();
    }
  });

  await test("session proxy forwards an allowed absolute-URI request to the pinned upstream", async () => {
    const upstream = http.createServer((req, res) => { res.writeHead(200); res.end("upstream-ok"); });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = upstream.address().port;
    const proxy = await egress.createSessionProxy(OPEN);
    try {
      const body = await new Promise((resolve, reject) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write(`GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`);
        });
        let buf = "";
        socket.on("data", (d) => { buf += d; });
        socket.on("end", () => resolve(buf));
        socket.on("error", reject);
      });
      assert.ok(body.includes("upstream-ok"), `proxy did not forward: ${body.slice(0, 80)}`);
    } finally {
      await proxy.close();
      await new Promise((r) => upstream.close(r));
    }
  });

  await test("session proxy refuses an unauthenticated client (not an open relay)", async () => {
    const upstream = http.createServer((req, res) => { res.writeHead(200); res.end("secret-upstream"); });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = upstream.address().port;
    const proxy = await egress.createSessionProxy(OPEN, { credential: { username: "u", password: "p" } });
    try {
      // No Proxy-Authorization header → must be refused with 407.
      const status = await new Promise((resolve, reject) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write(`GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        });
        let buf = "";
        socket.on("data", (d) => { buf += d; });
        socket.on("end", () => resolve(buf));
        socket.on("error", reject);
      });
      assert.ok(status.includes("407"), `unauthenticated proxy use should be 407: ${status.slice(0, 80)}`);
      assert.ok(!status.includes("secret-upstream"), "proxy leaked upstream content to an unauthenticated client");
      // With the correct credential it works.
      const auth = "Basic " + Buffer.from("u:p").toString("base64");
      const ok = await new Promise((resolve, reject) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write(`GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`);
        });
        let buf = "";
        socket.on("data", (d) => { buf += d; });
        socket.on("end", () => resolve(buf));
        socket.on("error", reject);
      });
      assert.ok(ok.includes("secret-upstream"), "authenticated proxy use should succeed");
    } finally {
      await proxy.close();
      await new Promise((r) => upstream.close(r));
    }
  });

  await test("a client reset tears down the upstream socket (no fd leak)", async () => {
    let originClosed = false;
    const origin = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("first-chunk"); // then hold the response open (slow origin)
      req.on("close", () => { originClosed = true; });
    });
    await new Promise((r) => origin.listen(0, "127.0.0.1", r));
    const originPort = origin.address().port;
    const proxy = await egress.createSessionProxy(OPEN);
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write(`GET http://127.0.0.1:${originPort}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
        });
        socket.on("data", () => { socket.destroy(); resolve(); }); // reset after first bytes
        socket.on("error", reject);
      });
      // Give the teardown a moment to propagate to the origin.
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(originClosed, "origin upstream socket was not torn down after client reset");
    } finally {
      await proxy.close();
      await new Promise((r) => origin.close(r));
    }
  });

  await test("session proxy refuses a request that targets the proxy itself", async () => {
    const blocked = [];
    const proxy = await egress.createSessionProxy(OPEN, { onBlocked: (r) => blocked.push(r) });
    try {
      const status = await new Promise((resolve, reject) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write(`GET http://127.0.0.1:${proxy.port}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        });
        let buf = "";
        socket.on("data", (d) => { buf += d; });
        socket.on("end", () => resolve(buf));
        socket.on("error", reject);
      });
      assert.ok(status.includes("403"), `self-targeting should be refused: ${status.slice(0, 80)}`);
    } finally {
      await proxy.close();
    }
  });

  await test("session proxy applies its connection ceiling to HTTP requests too", async () => {
    const proxy = await egress.createSessionProxy(CLOSED);
    try {
      assert.strictEqual(proxy.server.maxConnections, 64, "HTTP proxy sockets must share the bounded session ceiling");
    } finally {
      await proxy.close();
    }
  });

  // --- Config clamping -----------------------------------------------------

  await test("config clamps out-of-range values and defaults dangerous posture off", () => {
    const prev = { ...process.env };
    process.env.SIDEKICK_BROWSER_MAX_SESSIONS = "9999";
    process.env.SIDEKICK_BROWSER_SESSION_TTL_MS = "10"; // below floor
    delete process.env.SIDEKICK_BROWSER_ALLOW_PRIVATE_NETWORK;
    const config = browserConfig();
    assert.ok(config.maxSessions <= 16, "maxSessions should be clamped");
    assert.ok(config.sessionTtlMs >= 60000, "ttl should be clamped up to the floor");
    assert.strictEqual(config.allowPrivateNetwork, false, "private network must default off");
    process.env = prev;
  });

  // --- Secret scrubbing ----------------------------------------------------

  await test("scrubSecrets removes tracked secret values from strings and nested data", () => {
    const session = { secretValues: new Set(["hunter2-fixture"]) };
    assert.strictEqual(sessionsStore.scrubSecrets(session, "value is hunter2-fixture!"), "value is [REDACTED:secret]!");
    const deep = sessionsStore.scrubSecretsDeep(session, { a: ["x", "hunter2-fixture"], b: { c: "hunter2-fixture" } });
    assert.deepStrictEqual(deep, { a: ["x", "[REDACTED:secret]"], b: { c: "[REDACTED:secret]" } });
  });

  await test("trackSecret ignores trivially short values", () => {
    const session = { secretValues: new Set() };
    sessionsStore.trackSecret(session, "ab");
    assert.strictEqual(session.secretValues.size, 0);
    sessionsStore.trackSecret(session, "long-enough");
    assert.strictEqual(session.secretValues.size, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:"); for (const f of failures) console.log(`  - ${f}`); }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error("FATAL:", error.stack || error); process.exit(1); });
