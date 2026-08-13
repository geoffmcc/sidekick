"use strict";

// Proxmox pack — integration and contract tests.
//
// The pack is exercised END TO END through the real Sidekick path: the bundled
// pack is installed and enabled through the real pack lifecycle, configured
// with a profile whose credential lives in the real encrypted secret store, and
// its tools are called through the real dispatcher. The only thing standing in
// for production is the Proxmox server itself — a local HTTPS mock that returns
// response shapes captured from real Proxmox 9.2 hardware.
//
// TLS is real: the mock serves a self-signed certificate and the pack must
// validate it by PINNING that certificate as the profile CA, and must FAIL when
// the CA is not pinned. There is no insecure mode to test because there is none.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const TEST_DATA_DIR = path.join(__dirname, "test-data-proxmox-pack");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(TEST_DATA_DIR, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_SECRET_KEY = "proxmox-pack-test-secret-key";

// A throwaway token whose secret tail is distinctive so leak checks are exact.
const TOKEN = "root@pam!ci=aaaabbbb-cccc-dddd-eeee-ffff00001111";
const TOKEN_SECRET = TOKEN.split("=").pop();

let failures = 0;
async function test(label, fn) {
  try {
    await fn();
    console.log(`Passed: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAILED: ${label}\n  ${error && error.stack ? error.stack : error}`);
  }
}
function json(result) {
  return JSON.parse(result.content[0].text);
}

// --- generate a self-signed cert for the mock (skip suite if openssl absent)
let certPem, keyPem;
try {
  const certPath = path.join(TEST_DATA_DIR, "mock-cert.pem");
  const keyPath = path.join(TEST_DATA_DIR, "mock-key.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  certPem = fs.readFileSync(certPath, "utf8");
  keyPem = fs.readFileSync(keyPath, "utf8");
} catch (e) {
  console.log("SKIP: openssl is unavailable, cannot generate a TLS cert for the Proxmox mock server.");
  console.log("Proxmox pack integration tests skipped (unit/security tests cover the pure logic).");
  process.exit(0);
}

// --- mock Proxmox API ------------------------------------------------------
// Response shapes mirror captured Proxmox 9.2 payloads. A tiny task state
// machine makes a submitted task run once then finish, so the poller is
// genuinely exercised.
const tasks = new Map();
let lastAuthHeader = null;

function send(res, status, data) {
  const body = JSON.stringify({ data });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}
function sendError(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: null, message }));
}

const NODES = [
  { node: "pve1", type: "node", status: "online", cpu: 0.03, maxcpu: 2, mem: 1268707328, maxmem: 3115499520, disk: 6188195840, maxdisk: 8940331008, uptime: 508, level: "", ssl_fingerprint: "AA:BB" },
];
const RESOURCES = [
  ...NODES.map(n => ({ ...n, id: `node/${n.node}` })),
  { id: "qemu/100", type: "qemu", vmid: 100, name: "web", node: "pve1", status: "running", template: 0, maxmem: 2147483648, maxcpu: 2, maxdisk: 34359738368, uptime: 3600 },
  { id: "qemu/101", type: "qemu", vmid: 101, name: "db", node: "pve1", status: "stopped", template: 0, maxmem: 2147483648, maxcpu: 2 },
  { id: "storage/pve1/local", type: "storage", storage: "local", node: "pve1", plugintype: "dir", content: "iso,backup", status: "available", shared: 0, disk: 100, maxdisk: 1000 },
  { id: "storage/pve1/local-lvm", type: "storage", storage: "local-lvm", node: "pve1", plugintype: "lvmthin", content: "images,rootdir", status: "available", shared: 0 },
];

const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
  lastAuthHeader = req.headers.authorization || null;
  const url = new URL(req.url, "https://127.0.0.1");
  const p = url.pathname.replace(/^\/api2\/json/, "");
  const method = req.method;

  // Auth gate: every route requires the PVEAPIToken header.
  if (lastAuthHeader !== `PVEAPIToken=${TOKEN}`) return sendError(res, 401, "authentication failure");

  if (method === "GET" && p === "/version") return send(res, 200, { release: "9.2", version: "9.2.10", repoid: "deadbeef" });
  if (method === "GET" && p === "/cluster/status") {
    return send(res, 200, [
      { type: "cluster", name: "pvetest", nodes: 1, quorate: 1 },
      { type: "node", name: "pve1", online: 1, ip: "10.0.0.11", local: 1 },
    ]);
  }
  if (method === "GET" && p === "/cluster/resources") return send(res, 200, RESOURCES);
  if (method === "GET" && p === "/storage") {
    return send(res, 200, [
      { storage: "local", type: "dir", content: "iso,backup", shared: 0 },
      { storage: "local-lvm", type: "lvmthin", content: "images,rootdir", shared: 0 },
    ]);
  }
  if (method === "GET" && p === "/nodes") return send(res, 200, NODES);
  if (method === "GET" && p === "/nodes/pve1/status") {
    return send(res, 200, { uptime: 508, pveversion: "pve-manager/9.2.10", "current-kernel": { release: "7.0.14-11-pve" }, cpu: 0.03, cpuinfo: { cpus: 2 }, loadavg: ["0.1", "0.2", "0.3"], memory: { used: 1268707328, total: 3115499520 }, rootfs: { used: 6188195840, total: 8940331008 } });
  }
  // node "leaky": returns a 500 whose body echoes the Authorization header,
  // simulating a Proxmox error that reflects request headers. The pack MUST
  // NOT let the token reach the tool result.
  if (method === "GET" && p === "/nodes/leaky/status") {
    return sendError(res, 500, `internal error while handling ${req.headers.authorization}`);
  }
  if (method === "GET" && p === "/cluster/ceph/status") return sendError(res, 500, "binary not installed: /usr/bin/ceph-mon");
  if (method === "GET" && p === "/cluster/sdn/vnets") return send(res, 200, []);
  if (method === "GET" && p === "/cluster/backup") return send(res, 200, []);
  if (method === "GET" && p === "/nodes/pve1/tasks") return send(res, 200, []);
  if (method === "GET" && p === "/nodes/pve1/qemu") return send(res, 200, RESOURCES.filter(r => r.type === "qemu").map(r => ({ vmid: r.vmid, name: r.name, status: r.status, maxmem: r.maxmem, maxcpu: r.maxcpu })));
  if (method === "GET" && /^\/nodes\/pve1\/qemu\/\d+\/config$/.test(p)) {
    const vmid = Number(p.split("/")[4]);
    if (vmid === 100) return send(res, 200, { name: "web", cores: 2, memory: 2048, agent: "1", ide2: "local:vm-100-cloudinit,media=cdrom", scsi0: "local-lvm:vm-100-disk-0" });
    return send(res, 200, { name: "db", cores: 2, memory: 2048 });
  }
  if (method === "GET" && /^\/nodes\/pve1\/qemu\/\d+\/status\/current$/.test(p)) {
    const vmid = Number(p.split("/")[4]);
    const r = RESOURCES.find(x => x.vmid === vmid) || {};
    return send(res, 200, { vmid, name: r.name, status: r.status, qmpstatus: r.status, maxmem: r.maxmem, maxcpu: r.maxcpu, template: 0, ha: { managed: 0 } });
  }
  if (method === "GET" && /^\/nodes\/pve1\/qemu\/\d+\/agent\//.test(p)) return sendError(res, 500, "No QEMU guest agent configured");

  // Lifecycle: POST returns a UPID; the task runs once then finishes OK.
  const lifecycleMatch = p.match(/^\/nodes\/pve1\/qemu\/(\d+)\/status\/(start|shutdown|reboot|stop)$/);
  if (method === "POST" && lifecycleMatch) {
    const upid = `UPID:pve1:00001234:0000ABCD:6A000000:${lifecycleMatch[2]}::root@pam:`;
    tasks.set(upid, { polls: 0 });
    return send(res, 200, upid);
  }
  if (method === "GET" && /^\/nodes\/pve1\/tasks\/UPID:[^/]+\/status$/.test(p)) {
    const upid = decodeURIComponent(p.split("/")[4]);
    const task = tasks.get(upid) || { polls: 5 };
    task.polls++;
    const running = task.polls < 2;
    return send(res, 200, { upid, node: "pve1", type: "qmstart", user: "root@pam", status: running ? "running" : "stopped", exitstatus: running ? undefined : "OK" });
  }

  return sendError(res, 501, `unmocked route ${method} ${p}`);
});

require("../src/db").runPendingMigrations();
const { loadSecrets, saveSecrets } = require("../src/core/secrets-store");
const { encryptSecret } = require("../src/core/secret-cipher");
const bundled = require("../src/packs/bundled");
const packLifecycle = require("../src/packs/lifecycle");
const { callInternalTool } = require("../src/tools/dispatcher");

function storeToken() {
  const secrets = loadSecrets();
  secrets["proxmox_test_token"] = { ...encryptSecret(TOKEN), created: "t", updated: "t" };
  saveSecrets(secrets);
}

(async () => {
  console.log("Running Proxmox pack integration tests...\n");

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const endpoint = `https://127.0.0.1:${port}`;
  storeToken();

  // Install + enable through the real pack lifecycle.
  bundled.installBundledPack("proxmox", { enable: true });
  const health = packLifecycle.health("proxmox");
  assert.strictEqual(health.status, "healthy", "Proxmox pack must be healthy before its tools are exercised");

  // Configure profiles: `main` (pinned CA, lifecycle enabled), `ro`
  // (read-only), and `notls` (no pinned CA, so TLS verification must fail).
  packLifecycle.configure("proxmox", {
    profiles: {
      main: { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true },
      ro: { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem },
      notls: { endpoint, token_ref: "secret:proxmox_test_token" },
    },
  });

  await test("PX.1: pack registers the proxmox and proxmox_guest tools with correct risk", async () => {
    const reg = require("../src/tools-legacy");
    assert.strictEqual(reg.getToolRisk("proxmox"), "low");
    assert.strictEqual(reg.getToolRisk("proxmox_guest"), "high");
  });

  await test("PX.2: cluster_summary returns a normalized cluster view over pinned TLS", async () => {
    const r = json(await callInternalTool("proxmox", { action: "cluster_summary", profile: "main" }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.version.version, "9.2.10");
    assert.strictEqual(r.cluster.mode, "cluster");
    assert.strictEqual(r.cluster.quorate, true);
    assert.strictEqual(r.guests.qemu, 2);
    assert.strictEqual(r.guests.running, 1);
    assert.deepStrictEqual(r.storage.types, ["dir", "lvmthin"]);
  });

  await test("PX.3: capabilities detects absent Ceph/PBS/SDN as not_detected, not errors", async () => {
    const r = json(await callInternalTool("proxmox", { action: "capabilities", profile: "main" }));
    assert.strictEqual(r.api.state, "authenticated");
    assert.strictEqual(r.ceph.state, "not_detected");
    assert.strictEqual(r.pbs.state, "not_detected");
    assert.strictEqual(r.sdn.state, "not_configured");
    assert.strictEqual(r.guest_agent.configured_guests, 1, "vm 100 has agent enabled");
    assert.strictEqual(r.cloud_init.state, "detected", "vm 100 has a cloud-init drive");
    assert.ok(r.automation.ansible, "automation providers are reported");
  });

  await test("PX.4: guest_status enriches with config and degrades when the agent is absent", async () => {
    const r = json(await callInternalTool("proxmox", { action: "guest_status", profile: "main", vmid: 100 }));
    assert.strictEqual(r.vmid, 100);
    assert.strictEqual(r.node, "pve1");
    assert.strictEqual(r.status, "running");
    assert.strictEqual(r.cloud_init.configured, true);
    assert.strictEqual(r.guest_agent.configured, true);
    assert.strictEqual(r.guest_agent.reachable, false, "the mock agent returns not-configured, so enrichment degrades");
  });

  await test("PX.5: list_nodes / node_status / list_storage / list_guests normalize", async () => {
    assert.strictEqual(json(await callInternalTool("proxmox", { action: "list_nodes", profile: "main" })).nodes[0].node, "pve1");
    const ns = json(await callInternalTool("proxmox", { action: "node_status", profile: "main", node: "pve1" }));
    assert.strictEqual(ns.pve_version, "pve-manager/9.2.10");
    assert.strictEqual(ns.memory.total_bytes, 3115499520);
    const guests = json(await callInternalTool("proxmox", { action: "list_guests", profile: "main", type: "qemu" }));
    assert.strictEqual(guests.total, 2);
    const storage = json(await callInternalTool("proxmox", { action: "list_storage", profile: "main" }));
    assert.ok(storage.types.includes("lvmthin"));
  });

  await test("PX.6: guest lifecycle start submits, monitors the task, and reports completion", async () => {
    const r = json(await callInternalTool("proxmox_guest", { action: "start", profile: "main", vmid: 101 }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.outcome, "completed");
    assert.strictEqual(r.monitored, true);
    assert.strictEqual(r.task.ok, true);
    assert.ok(r.task.upid.startsWith("UPID:"));
  });

  await test("PX.7: starting an already-running guest is an idempotent no-op", async () => {
    const r = json(await callInternalTool("proxmox_guest", { action: "start", profile: "main", vmid: 100 }));
    assert.strictEqual(r.outcome, "already_running");
    assert.strictEqual(r.changed, false);
  });

  await test("PX.8: shutting down an already-stopped guest is an idempotent no-op", async () => {
    const r = json(await callInternalTool("proxmox_guest", { action: "shutdown", profile: "main", vmid: 101 }));
    assert.strictEqual(r.outcome, "already_stopped");
    assert.strictEqual(r.changed, false);
  });

  await test("PX.9: a read-only profile refuses lifecycle operations", async () => {
    const r = json(await callInternalTool("proxmox_guest", { action: "start", profile: "ro", vmid: 101 }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "lifecycle_disabled");
  });

  await test("PX.10: TLS verification fails closed when the self-signed CA is not pinned", async () => {
    const r = json(await callInternalTool("proxmox", { action: "version", profile: "notls" }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "tls_failure", JSON.stringify(r));
  });

  await test("PX.11: a Proxmox error that echoes the auth header never leaks the token", async () => {
    const result = await callInternalTool("proxmox", { action: "node_status", profile: "main", node: "leaky" });
    const text = result.content[0].text;
    assert.ok(!text.includes(TOKEN), "the full token must not appear");
    assert.ok(!text.includes(TOKEN_SECRET), "the token secret must not appear");
    // Any PVEAPIToken= occurrence must be the redacted form, never a live value.
    assert.ok(!/PVEAPIToken=(?!\[REDACTED\])[^\s"'\],]/.test(text), "no live PVEAPIToken value survives");
    assert.ok(text.includes("[REDACTED]"), "the reflected header is redacted, not dropped silently");
  });

  await test("PX.12: an unknown profile and an invalid vmid are rejected with structured errors", async () => {
    const badProfile = json(await callInternalTool("proxmox", { action: "version", profile: "does-not-exist" }));
    assert.strictEqual(badProfile.code, "profile_not_found");
    const badVmid = json(await callInternalTool("proxmox", { action: "guest_status", profile: "main", vmid: "../105" }));
    assert.strictEqual(badVmid.ok, false);
    assert.strictEqual(badVmid.code, "invalid_input");
  });

  await test("PX.13: the tool never exposes a way to supply a raw endpoint", async () => {
    // The read tool schema has no endpoint/url field; an attempt to pass one is
    // dropped by schema validation and the configured profile is used instead.
    const r = json(await callInternalTool("proxmox", { action: "version", profile: "main", url: "https://attacker.example.invalid", endpoint: "https://attacker.example.invalid" }));
    assert.strictEqual(r.ok, true, "extra endpoint-like args are ignored, not honored");
    assert.strictEqual(r.version.version, "9.2.10");
  });

  await test("PX.14: list_profiles and detect_providers work without an API session", async () => {
    const lp = json(await callInternalTool("proxmox", { action: "list_profiles" }));
    assert.ok(lp.profiles.find(p => p.name === "main" && p.valid));
    assert.strictEqual(lp.profiles.find(p => p.name === "notls").tls, "system_ca");
    const dp = json(await callInternalTool("proxmox", { action: "detect_providers" }));
    assert.ok(dp.providers.ansible && dp.providers.ansible.state.match(/installed|not_installed/));
  });

  await test("PX.15: an invalid profile makes pack health fail closed, and is recoverable", async () => {
    packLifecycle.configure("proxmox", { profiles: { broken: { endpoint: "http://insecure:8006", token_ref: "secret:proxmox_test_token" } } });
    assert.notStrictEqual(packLifecycle.health("proxmox").status, "healthy", "an invalid profile must not report healthy");
    // Restore a valid configuration and confirm health recovers.
    packLifecycle.configure("proxmox", { profiles: { main: { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, default: true } } });
    assert.strictEqual(packLifecycle.health("proxmox").status, "healthy", "valid configuration restores health");
  });

  await test("PX.16: an unconfigured pack (zero profiles) is healthy but inert", async () => {
    packLifecycle.configure("proxmox", { profiles: {} });
    assert.strictEqual(packLifecycle.health("proxmox").status, "healthy", "installed-but-unconfigured is healthy");
    const r = json(await callInternalTool("proxmox", { action: "version" }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "not_configured");
    // Restore for any later assertions.
    packLifecycle.configure("proxmox", { profiles: { main: { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, default: true } } });
  });

  server.close();
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Proxmox pack integration tests passed.");
})().catch(e => { console.error("FATAL", e && e.stack ? e.stack : e); server.close(); process.exit(1); });
