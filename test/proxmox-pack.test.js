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
let failNextConfigPost = false;

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
  { node: "pve2", type: "node", status: "online", cpu: 0.02, maxcpu: 2, mem: 1000000000, maxmem: 3115499520, uptime: 600 },
];
const RESOURCES = [
  ...NODES.map(n => ({ ...n, id: `node/${n.node}` })),
  { id: "qemu/100", type: "qemu", vmid: 100, name: "web", node: "pve1", status: "running", template: 0, maxmem: 2147483648, maxcpu: 2, maxdisk: 34359738368, uptime: 3600 },
  { id: "qemu/101", type: "qemu", vmid: 101, name: "db", node: "pve1", status: "stopped", template: 0, maxmem: 2147483648, maxcpu: 2 },
  { id: "storage/pve1/local", type: "storage", storage: "local", node: "pve1", plugintype: "dir", content: "iso,backup", status: "available", shared: 0, disk: 100, maxdisk: 1000 },
  { id: "storage/pve1/local-lvm", type: "storage", storage: "local-lvm", node: "pve1", plugintype: "lvmthin", content: "images,rootdir", status: "available", shared: 0 },
];

// Dynamic guest store so provisioning/snapshot/delete are stateful. Seeded with
// the two read-test guests; provisioning adds more.
const store = new Map([
  [100, { vmid: 100, node: "pve1", kind: "qemu", status: "running", template: 0, config: { name: "web", cores: 2, memory: 2048, agent: "1", ide2: "local:vm-100-cloudinit,media=cdrom", scsi0: "local-lvm:vm-100-disk-0" }, snapshots: [] }],
  [101, { vmid: 101, node: "pve1", kind: "qemu", status: "stopped", template: 0, config: { name: "db", cores: 2, memory: 2048 }, snapshots: [] }],
]);
let nextFreeId = 200;
function resourcesView() {
  const guests = [...store.values()].map(g => ({ id: `${g.kind}/${g.vmid}`, type: g.kind, vmid: g.vmid, name: g.config.name, node: g.node, status: g.status, template: g.template, maxmem: (g.config.memory || 512) * 1048576, maxcpu: g.config.cores || 1 }));
  return [...NODES.map(n => ({ ...n, id: `node/${n.node}` })), ...guests, ...RESOURCES.filter(r => r.type === "storage")];
}
function parseBody(raw) {
  const params = new URLSearchParams(raw || "");
  const obj = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}
function newUpid(kind) {
  const upid = `UPID:pve1:0000${Math.floor(Math.random() * 65536).toString(16)}:0000ABCD:6A000000:${kind}::root@pam:`;
  tasks.set(upid, { polls: 0 });
  return upid;
}

const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => handle(req, res, raw));
});

function handle(req, res, raw) {
  lastAuthHeader = req.headers.authorization || null;
  const url = new URL(req.url, "https://127.0.0.1");
  const p = url.pathname.replace(/^\/api2\/json/, "");
  const method = req.method;
  const body = method === "GET" ? {} : parseBody(raw);

  // Auth gate: every route requires the PVEAPIToken header.
  if (lastAuthHeader !== `PVEAPIToken=${TOKEN}`) return sendError(res, 401, "authentication failure");

  // --- provisioning: stateful routes ---
  if (method === "GET" && p === "/cluster/nextid") return send(res, 200, String(nextFreeId));
  if (method === "POST" && p === "/nodes/pve1/qemu") {
    const vmid = Number(body.vmid) || nextFreeId++;
    if (Number(body.vmid) >= nextFreeId) nextFreeId = Number(body.vmid) + 1;
    store.set(vmid, { vmid, node: "pve1", kind: "qemu", status: "stopped", template: 0, config: { name: body.name, cores: Number(body.cores), memory: Number(body.memory), tags: body.tags, description: body.description }, snapshots: [] });
    return send(res, 200, newUpid("qmcreate"));
  }
  const cfgMatch = p.match(/^\/nodes\/pve1\/qemu\/(\d+)\/config$/);
  if (cfgMatch && method === "POST") {
    const g = store.get(Number(cfgMatch[1]));
    if (!g) return sendError(res, 500, "config does not exist");
    // One-shot fault injection for the clone provenance-stamp path: the clone
    // task succeeds, then the follow-up config POST (the stamp) fails once.
    if (failNextConfigPost) {
      failNextConfigPost = false;
      return sendError(res, 500, "simulated failure while writing the config");
    }
    Object.assign(g.config, Object.fromEntries(Object.entries(body).map(([k, v]) => [k, /^(cores|memory)$/.test(k) ? Number(v) : v])));
    return send(res, 200, null);
  }
  const snapMatch = p.match(/^\/nodes\/pve1\/qemu\/(\d+)\/snapshot$/);
  if (snapMatch && method === "POST") {
    const g = store.get(Number(snapMatch[1]));
    if (!g) return sendError(res, 500, "does not exist");
    g.snapshots.push({ name: body.snapname, description: body.description || "", snaptime: 1700000000 });
    return send(res, 200, newUpid("qmsnapshot"));
  }
  if (snapMatch && method === "GET") {
    const g = store.get(Number(snapMatch[1])) || { snapshots: [] };
    return send(res, 200, [...g.snapshots, { name: "current", description: "You are here!" }]);
  }
  const tmplMatch = p.match(/^\/nodes\/pve1\/qemu\/(\d+)\/template$/);
  if (tmplMatch && method === "POST") {
    const g = store.get(Number(tmplMatch[1]));
    if (!g) return sendError(res, 500, "does not exist");
    if (g.snapshots.length) return sendError(res, 500, "unable to create template, because VM contains snapshots");
    g.template = 1;
    return send(res, 200, null);
  }
  const cloneMatch = p.match(/^\/nodes\/pve1\/qemu\/(\d+)\/clone$/);
  if (cloneMatch && method === "POST") {
    const src = store.get(Number(cloneMatch[1]));
    if (!src) return sendError(res, 500, "does not exist");
    const newid = Number(body.newid);
    store.set(newid, { vmid: newid, node: "pve1", kind: "qemu", status: "stopped", template: 0, config: { name: body.name || `${src.config.name}-clone`, cores: src.config.cores, memory: src.config.memory }, snapshots: [] });
    if (newid >= nextFreeId) nextFreeId = newid + 1;
    return send(res, 200, newUpid("qmclone"));
  }
  const delMatch = p.match(/^\/nodes\/pve1\/qemu\/(\d+)$/);
  if (delMatch && method === "DELETE") {
    store.delete(Number(delMatch[1]));
    return send(res, 200, newUpid("qmdestroy"));
  }

  if (method === "GET" && p === "/version") return send(res, 200, { release: "9.2", version: "9.2.10", repoid: "deadbeef" });
  if (method === "GET" && p === "/cluster/status") {
    return send(res, 200, [
      { type: "cluster", name: "pvetest", nodes: 2, quorate: 1 },
      { type: "node", name: "pve1", online: 1, ip: "10.0.0.11", local: 1 },
      { type: "node", name: "pve2", online: 1, ip: "10.0.0.12", local: 0 },
    ]);
  }
  if (method === "GET" && p === "/cluster/resources") return send(res, 200, resourcesView());
  if (method === "GET" && p === "/storage") {
    return send(res, 200, [
      { storage: "local", type: "dir", content: "iso,backup", shared: 0 },
      { storage: "local-lvm", type: "lvmthin", content: "images,rootdir", shared: 0 },
    ]);
  }
  if (method === "GET" && p === "/nodes/pve1/storage") {
    return send(res, 200, [{ storage: "local", type: "dir", shared: 0, status: "available" }, { storage: "local-lvm", type: "lvmthin", shared: 0, status: "available" }]);
  }
  if (method === "GET" && p === "/nodes") return send(res, 200, NODES);
  if (method === "GET" && p === "/nodes/pve1/status") {
    return send(res, 200, { uptime: 508, pveversion: "pve-manager/9.2.10", "current-kernel": { release: "7.0.14-11-pve" }, cpu: 0.03, cpuinfo: { cpus: 2 }, loadavg: ["0.1", "0.2", "0.3"], memory: { used: 1268707328, total: 3115499520 }, rootfs: { used: 6188195840, total: 8940331008 } });
  }
  const migrateMatch = p.match(/^\/nodes\/pve1\/(qemu|lxc)\/(\d+)\/migrate$/);
  if (method === "POST" && migrateMatch) {
    const g = store.get(Number(migrateMatch[2]));
    if (!g) return sendError(res, 500, "does not exist");
    g.node = body.target;
    const upid = newUpid("qmigrate");
    return send(res, 200, upid);
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
  if (method === "GET" && p === "/nodes/pve1/qemu") return send(res, 200, [...store.values()].map(g => ({ vmid: g.vmid, name: g.config.name, status: g.status, maxmem: (g.config.memory || 512) * 1048576, maxcpu: g.config.cores || 1 })));
  if (cfgMatch && method === "GET") {
    const g = store.get(Number(cfgMatch[1]));
    if (!g) return sendError(res, 500, "config does not exist");
    return send(res, 200, { ...g.config, ...(g.template ? { template: 1 } : {}) });
  }
  if (method === "GET" && /^\/nodes\/pve1\/qemu\/\d+\/status\/current$/.test(p)) {
    const vmid = Number(p.split("/")[4]);
    const g = store.get(vmid);
    if (!g) return sendError(res, 500, "does not exist");
    return send(res, 200, { vmid, name: g.config.name, status: g.status, qmpstatus: g.status, maxmem: (g.config.memory || 512) * 1048576, maxcpu: g.config.cores || 1, template: g.template, ha: { managed: 0 } });
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
}

require("../src/db").runPendingMigrations();
const { loadSecrets, saveSecrets } = require("../src/core/secrets-store");
const { encryptSecret } = require("../src/core/secret-cipher");
const bundled = require("../src/packs/bundled");
const packLifecycle = require("../src/packs/lifecycle");
const { callInternalTool } = require("../src/tools/dispatcher");
const LIB = path.resolve(__dirname, "..", "packs", "proxmox", "modules", "proxmox-tools", "lib");
const provenance = require(path.join(LIB, "provenance.js"));

// The test-only guarded DELETE: it exists ONLY here, never in the shipped
// client. It reads the target back, proves the exact Sidekick test-ownership
// marker, and refuses anything it cannot prove it created.
function directRequest(port, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const r = https.request({ host: "127.0.0.1", port, method, path: `/api2/json${apiPath}`, ca: certPem, rejectUnauthorized: true,
      headers: { Authorization: `PVEAPIToken=${TOKEN}`, ...(data ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) } : {}) } },
      res => { let b = ""; res.on("data", c => b += c); res.on("end", () => { try { resolve(JSON.parse(b).data); } catch { resolve(null); } }); });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
async function guardedDelete(port, node, vmid, expectedMarker) {
  const cfg = await directRequest(port, "GET", `/nodes/${node}/qemu/${vmid}/config`).catch(() => null);
  if (!cfg) return { deleted: false, reason: "already absent" };
  const check = provenance.checkOwnership(cfg, { requireManaged: true, requireTest: true, requireMarker: expectedMarker });
  if (!check.ok) return { deleted: false, refused: true, reason: check.reason };
  await directRequest(port, "DELETE", `/nodes/${node}/qemu/${vmid}`);
  const after = await directRequest(port, "GET", `/nodes/${node}/qemu/${vmid}/config`).catch(() => null);
  return { deleted: !after };
}

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

  await test("PX.5a: read-only health, capacity and upgrade readiness remain evidence-based", async () => {
    const health = json(await callInternalTool("proxmox", { action: "cluster_health", profile: "main" }));
    assert.strictEqual(health.status, "healthy", JSON.stringify(health));
    assert.deepStrictEqual(health.blockers, []);
    const capacity = json(await callInternalTool("proxmox", { action: "storage_capacity", profile: "main" }));
    assert.strictEqual(capacity.total, 2);
    assert.strictEqual(capacity.totals.total_bytes, null, "mock rows omit capacity and must remain unknown");
    const readiness = json(await callInternalTool("proxmox", { action: "upgrade_readiness", profile: "main" }));
    assert.strictEqual(readiness.status, "blocked_or_review");
    assert.ok(readiness.blockers.some((x) => x.code === "backup_evidence_missing"));
  });

  await test("PX.5b: guest inventory, readiness and backup coverage are bounded reads", async () => {
    const inventory = json(await callInternalTool("proxmox", { action: "guest_inventory", profile: "main" }));
    assert.strictEqual(inventory.total, 2);
    assert.strictEqual(inventory.counts.running, 1);
    const readiness = json(await callInternalTool("proxmox", { action: "guest_readiness", profile: "main", vmid: 100 }));
    assert.strictEqual(readiness.status, "attention");
    assert.ok(readiness.findings.some((x) => x.code === "guest_agent_unreachable"));
    const coverage = json(await callInternalTool("proxmox", { action: "backup_coverage", profile: "main" }));
    assert.strictEqual(coverage.uncovered_guests.length, 2);
    assert.ok(coverage.note.includes("does not verify PBS"));
  });

  await test("PX.5c: storage health and backup history preserve unknown evidence", async () => {
    const storage = json(await callInternalTool("proxmox", { action: "storage_health", profile: "main" }));
    assert.strictEqual(storage.status, "observed");
    assert.strictEqual(storage.findings.filter((x) => x.code === "capacity_unknown").length, 2);
    const history = json(await callInternalTool("proxmox", { action: "backup_history", profile: "main" }));
    assert.strictEqual(history.total_tasks, 0);
    assert.strictEqual(history.latest, null);
    assert.ok(history.note.includes("does not verify restoreability"));
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

  await test("PX3.1: maintenance preflight returns a deterministic safe/blocked shape", async () => {
    const r = json(await callInternalTool("proxmox", { action: "maintenance_preflight", profile: "main", node: "pve1" }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.node, "pve1");
    assert.strictEqual(r.decision, "safe_to_begin_preflight_only");
    assert.strictEqual(r.providers.host_maintenance, "not_claimed_without_governed_backend");
    assert.strictEqual(r.guests.running, 1);
  });

  await test("PX3.2: migration dry-run and execution use the real dispatcher and verify target placement", async () => {
    const dry = json(await callInternalTool("proxmox_migrate", { action: "migrate", profile: "main", vmid: 101, target_node: "pve2", dry_run: true }));
    assert.strictEqual(dry.ok, true, JSON.stringify(dry));
    assert.strictEqual(dry.dry_run, true);
    assert.strictEqual(dry.explain.resolved.node, "pve1");
    const moved = json(await callInternalTool("proxmox_migrate", { action: "migrate", profile: "main", vmid: 101, target_node: "pve2" }));
    assert.strictEqual(moved.ok, true, JSON.stringify(moved));
    assert.strictEqual(moved.outcome, "completed");
    assert.strictEqual(moved.final_node, "pve2");
  });

  // --- phase 2: provisioning, provenance, policy, guarded delete, ansible ---

  await test("PXV.1: proxmox_provision and ansible_run register with high risk", async () => {
    const reg = require("../src/tools-legacy");
    assert.strictEqual(reg.getToolRisk("proxmox_provision"), "high");
    assert.strictEqual(reg.getToolRisk("ansible_run"), "high");
    assert.strictEqual(reg.getToolRisk("proxmox_migrate"), "high");
    assert.strictEqual(reg.getToolRisk("proxmox_retire"), "critical");
  });

  await test("PXV.2: create_vm provisions a provenance-tagged guest through the tool", async () => {
    const r = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-int-vm", cores: 1, memory: 512, disk: { storage: "local-lvm", size_gb: 1 } } }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.outcome, "created");
    assert.ok(r.vmid >= 200, "a free vmid was allocated");
    assert.ok(r.tags.includes("sidekick-managed"), "created guest is tagged sidekick-managed");
    assert.ok(r.marker, "a provenance marker was recorded");
    // The plan/explain is included and deterministic.
    assert.strictEqual(r.explain.risk_class, "mutating");
    // Read the config back through the read tool and confirm provenance is real.
    const cfg = json(await callInternalTool("proxmox", { action: "guest_status", profile: "main", vmid: r.vmid }));
    assert.strictEqual(cfg.vmid, r.vmid);
  });

  await test("PXV.3: dry_run returns a plan and makes no change", async () => {
    const before = json(await callInternalTool("proxmox", { action: "list_guests", profile: "main" })).total;
    const r = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", dry_run: true, vm: { node: "pve1", name: "sk-dry", cores: 1, memory: 512 } }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dry_run, true);
    assert.ok(r.explain && r.explain.expected_effect, "explain carries the expected effect");
    const after = json(await callInternalTool("proxmox", { action: "list_guests", profile: "main" })).total;
    assert.strictEqual(after, before, "dry run created nothing");
  });

  await test("PXV.4: configure changes cpu/memory and verifies by read-back", async () => {
    const created = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-cfg", cores: 1, memory: 512, disk: { storage: "local-lvm", size_gb: 1 } } }));
    const r = json(await callInternalTool("proxmox_provision", { action: "configure", profile: "main", vmid: created.vmid, configure: { memory: 1024 } }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.applied.memory, 1024);
  });

  await test("PXV.5: snapshot_create then list_snapshots reflects it", async () => {
    const created = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-snap", cores: 1, memory: 512, disk: { storage: "local-lvm", size_gb: 1 } } }));
    const snap = json(await callInternalTool("proxmox_provision", { action: "snapshot_create", profile: "main", vmid: created.vmid, snapshot: { snapname: "s1" } }));
    assert.strictEqual(snap.ok, true, JSON.stringify(snap));
    const list = json(await callInternalTool("proxmox", { action: "list_snapshots", profile: "main", node: "pve1", vmid: created.vmid }));
    assert.ok(list.snapshots.some(s => s.name === "s1"));
  });

  await test("PXV.6: clone produces a new provenance-tagged guest", async () => {
    const tmpl = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-tmpl", cores: 1, memory: 512, disk: { storage: "local-lvm", size_gb: 1 } } }));
    await callInternalTool("proxmox_provision", { action: "convert_template", profile: "main", vmid: tmpl.vmid });
    const clone = json(await callInternalTool("proxmox_provision", { action: "clone", profile: "main", clone: { node: "pve1", source_vmid: tmpl.vmid, name: "sk-clone" } }));
    assert.strictEqual(clone.ok, true, JSON.stringify(clone));
    assert.notStrictEqual(clone.vmid, tmpl.vmid);
    assert.ok(clone.tags.includes("sidekick-managed"));
  });

  await test("PXV.7: a protected resource is refused by deterministic policy", async () => {
    const created = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-prot", cores: 1, memory: 512, disk: { storage: "local-lvm", size_gb: 1 } } }));
    packLifecycle.configure("proxmox", {
      protected_resources: [{ vmid: created.vmid }],
      profiles: { main: { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true } },
    });
    const r = json(await callInternalTool("proxmox_provision", { action: "configure", profile: "main", vmid: created.vmid, configure: { memory: 2048 } }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "protected_resource");
    // Protection is a hard deny for ALL mutating ops, snapshots included.
    const snap = json(await callInternalTool("proxmox_provision", { action: "snapshot_create", profile: "main", vmid: created.vmid, snapshot: { snapname: "nope" } }));
    assert.strictEqual(snap.ok, false);
    assert.strictEqual(snap.code, "protected_resource");
    // restore config without protection
    packLifecycle.configure("proxmox", { profiles: { main: { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true } } });
  });

  await test("PXV.8: the test-only guarded DELETE verifies ownership and refuses foreign resources", async () => {
    // Create a disposable TEST resource directly with a test-ownership marker.
    const prov = provenance.buildProvenance({ run: "int-test", test: true });
    const marker = prov.marker;
    await directRequest(port, "POST", "/nodes/pve1/qemu", { vmid: 990, name: "sk-del-test", tags: prov.tags, description: prov.description });
    // The guard deletes it because the exact marker matches.
    const ok = await guardedDelete(port, "pve1", 990, marker);
    assert.strictEqual(ok.deleted, true, JSON.stringify(ok));
    // The guard REFUSES a guest it cannot prove it created (vmid 100, unmarked).
    const refused = await guardedDelete(port, "pve1", 100, marker);
    assert.strictEqual(refused.deleted, false);
    assert.strictEqual(refused.refused, true);
  });

  await test("PXV.9: ansible_run detect reports state and dry_run without config is not_ready", async () => {
    const det = json(await callInternalTool("ansible_run", { action: "detect" }));
    assert.strictEqual(det.ok, true);
    assert.ok(["not_installed", "installed_unconfigured", "misconfigured", "ready"].includes(det.ansible.state));
    const dry = json(await callInternalTool("ansible_run", { action: "dry_run", playbook: "baseline.yml", hosts: [{ alias: "h", host: "10.0.0.9" }] }));
    // Not configured (no playbook_dir) or ansible absent -> a clean not-ready code, never a crash.
    assert.strictEqual(dry.ok, false);
    assert.ok(["not_configured", "provider_unavailable"].includes(dry.code), dry.code);
  });

  await test("PXV.10: guarded retirement is disabled by default and dry-run explains the denial", async () => {
    const created = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-retire-default", cores: 1, memory: 512 } }));
    const r = json(await callInternalTool("proxmox_retire", { action: "retire", profile: "main", vmid: created.vmid, dry_run: true, require_test: true, marker: created.marker }));
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.outcome, "denied");
    assert.ok(r.explain.decision.reasons.some(x => /destroy policy/i.test(x)));
  });

  await test("PXV.11: enabled retirement accepts only an exact disposable provenance marker and verifies absence", async () => {
    const prov = provenance.buildProvenance({ run: "retire-test", test: true });
    await directRequest(port, "POST", "/nodes/pve1/qemu", { vmid: 991, name: "sk-retire-test", tags: prov.tags, description: prov.description });
    packLifecycle.configure("proxmox", { allow_destroy: true, profiles: { main: { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true } } });
    const r = json(await callInternalTool("proxmox_retire", { action: "retire", profile: "main", vmid: 991, require_test: true, marker: prov.marker }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.outcome, "completed");
    assert.strictEqual(r.verified_absent, true);
  });

  await test("PXV.12: proxmox_guest refuses every lifecycle action on a protected guest, start included", async () => {
    const mainProfile = { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true };
    // A fresh STOPPED guest on pve1 (vmid 101 lives on pve2 after PX3.2's migration).
    const created = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-prot-guest", cores: 1, memory: 512 } }));
    assert.strictEqual(created.ok, true, JSON.stringify(created));
    packLifecycle.configure("proxmox", { protected_resources: [{ vmid: 100 }, { vmid: created.vmid }], profiles: { main: mainProfile } });
    const shutdown = json(await callInternalTool("proxmox_guest", { action: "shutdown", profile: "main", vmid: 100 }));
    assert.strictEqual(shutdown.ok, false);
    assert.strictEqual(shutdown.code, "protected_resource", JSON.stringify(shutdown));
    const reboot = json(await callInternalTool("proxmox_guest", { action: "reboot", profile: "main", vmid: 100 }));
    assert.strictEqual(reboot.code, "protected_resource");
    // start of a DELIBERATELY STOPPED protected guest is denied too: protection
    // is a uniform hard deny for all lifecycle mutations, not a shutdown-only
    // carve-out — a quarantined guest must not be brought back up by an agent.
    const start = json(await callInternalTool("proxmox_guest", { action: "start", profile: "main", vmid: created.vmid }));
    assert.strictEqual(start.ok, false);
    assert.strictEqual(start.code, "protected_resource");
    // Removing the protection restores normal behaviour for the same guest.
    packLifecycle.configure("proxmox", { profiles: { main: mainProfile } });
    const unprotected = json(await callInternalTool("proxmox_guest", { action: "start", profile: "main", vmid: created.vmid }));
    assert.strictEqual(unprotected.outcome, "completed", `removing protection restores normal behaviour: ${JSON.stringify(unprotected)}`);
  });

  await test("PXV.13: cloning a protected source VM is refused by the same deterministic policy", async () => {
    const mainProfile = { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true };
    const tmpl = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-prot-src", cores: 1, memory: 512, disk: { storage: "local-lvm", size_gb: 1 } } }));
    assert.strictEqual(tmpl.ok, true, JSON.stringify(tmpl));
    packLifecycle.configure("proxmox", { protected_resources: [{ vmid: tmpl.vmid }], profiles: { main: mainProfile } });
    const before = json(await callInternalTool("proxmox", { action: "list_guests", profile: "main" })).total;
    const clone = json(await callInternalTool("proxmox_provision", { action: "clone", profile: "main", clone: { node: "pve1", source_vmid: tmpl.vmid, name: "sk-prot-clone" } }));
    assert.strictEqual(clone.ok, false);
    assert.strictEqual(clone.code, "protected_resource", JSON.stringify(clone));
    // The explain names the SOURCE guest the decision was made about.
    assert.strictEqual(clone.explain.resolved.vmid, tmpl.vmid);
    const after = json(await callInternalTool("proxmox", { action: "list_guests", profile: "main" })).total;
    assert.strictEqual(after, before, "a denied clone creates nothing");
    packLifecycle.configure("proxmox", { profiles: { main: mainProfile } });
  });

  await test("PXV.14: a clone whose provenance stamp fails is a loud reconciliation_required naming the orphan", async () => {
    const tmpl = json(await callInternalTool("proxmox_provision", { action: "create_vm", profile: "main", vm: { node: "pve1", name: "sk-orphan-src", cores: 1, memory: 512, disk: { storage: "local-lvm", size_gb: 1 } } }));
    assert.strictEqual(tmpl.ok, true, JSON.stringify(tmpl));
    failNextConfigPost = true; // the clone task will succeed; the stamp POST fails
    const clone = json(await callInternalTool("proxmox_provision", { action: "clone", profile: "main", clone: { node: "pve1", source_vmid: tmpl.vmid, name: "sk-orphan-clone" } }));
    assert.strictEqual(clone.ok, false);
    assert.strictEqual(clone.code, "reconciliation_required", JSON.stringify(clone));
    const orphan = clone.details.orphaned_vmid;
    assert.ok(Number.isInteger(orphan) && orphan !== tmpl.vmid, "the orphaned vmid is named");
    assert.ok(String(clone.error).includes(String(orphan)), "the error message names the orphaned vmid");
    assert.strictEqual(clone.details.cloned_from, tmpl.vmid);
    // The guest really does exist on the provider WITHOUT provenance — that is
    // exactly why the failure must be loud.
    const status = json(await callInternalTool("proxmox", { action: "guest_status", profile: "main", vmid: orphan }));
    assert.strictEqual(status.vmid, orphan);
  });

  await test("PXV.15: list_profiles surfaces a tls_servername override so operators can see it", async () => {
    const mainProfile = { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true };
    packLifecycle.configure("proxmox", { profiles: {
      main: mainProfile,
      sni: { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, tls_servername: "pve.test" },
    } });
    const lp = json(await callInternalTool("proxmox", { action: "list_profiles" }));
    const sni = lp.profiles.find(p => p.name === "sni");
    assert.strictEqual(sni.valid, true);
    assert.strictEqual(sni.tls, "pinned_ca");
    assert.strictEqual(sni.tls_servername, "pve.test", "the SNI override is visible in the listing");
    assert.strictEqual(lp.profiles.find(p => p.name === "main").tls_servername, undefined, "absent override stays absent");
    packLifecycle.configure("proxmox", { profiles: { main: mainProfile } });
  });

  await test("PXV.16: tls_servername drives real SNI + certificate validation against an IP endpoint", async () => {
    // A second mock with a DNS-only SAN: connecting by IP can only validate if
    // the client presents the override as SNI/verification name. The server
    // records the servername actually observed on the TLS socket.
    const sniCert = path.join(TEST_DATA_DIR, "sni-cert.pem");
    const sniKey = path.join(TEST_DATA_DIR, "sni-key.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", sniKey, "-out", sniCert, "-days", "2",
      "-subj", "/CN=pve.test", "-addext", "subjectAltName=DNS:pve.test",
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const sniCertPem = fs.readFileSync(sniCert, "utf8");
    let observedServername = null;
    const sniServer = https.createServer({ cert: sniCertPem, key: fs.readFileSync(sniKey, "utf8") }, (req, res) => {
      observedServername = req.socket.servername || null;
      if ((req.headers.authorization || null) !== `PVEAPIToken=${TOKEN}`) return sendError(res, 401, "authentication failure");
      if (req.url.replace(/^\/api2\/json/, "") === "/version") return send(res, 200, { release: "9.2", version: "9.2.10", repoid: "cafef00d" });
      return sendError(res, 501, "unmocked");
    });
    await new Promise(resolve => sniServer.listen(0, "127.0.0.1", resolve));
    const sniPort = sniServer.address().port;
    const mainProfile = { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true };
    try {
      packLifecycle.configure("proxmox", { profiles: {
        main: mainProfile,
        sni: { endpoint: `https://127.0.0.1:${sniPort}`, token_ref: "secret:proxmox_test_token", ca_pem: sniCertPem, tls_servername: "pve.test" },
        "sni-missing": { endpoint: `https://127.0.0.1:${sniPort}`, token_ref: "secret:proxmox_test_token", ca_pem: sniCertPem },
      } });
      // Without the override the DNS-only certificate cannot match the IP.
      const failed = json(await callInternalTool("proxmox", { action: "version", profile: "sni-missing" }));
      assert.strictEqual(failed.ok, false);
      assert.strictEqual(failed.code, "tls_failure", JSON.stringify(failed));
      // With the override, validation succeeds AND the server saw the SNI.
      const r = json(await callInternalTool("proxmox", { action: "version", profile: "sni" }));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.version.version, "9.2.10");
      assert.strictEqual(observedServername, "pve.test", "the TLS socket must carry the configured SNI");
    } finally {
      sniServer.close();
      packLifecycle.configure("proxmox", { profiles: { main: mainProfile } });
    }
  });

  await test("PXV.17: ansible_run run executes end to end through the governed bash tool and derives success from JSON stats", async () => {
    // A shimmed ansible-playbook on PATH emits a captured-shape JSON stats
    // document on stdout and a warning on stderr — the pack must run it
    // through the REAL dispatcher/bash path, isolate the JSON from the
    // appended stderr, and derive per-host success from the stats, never from
    // "the command ran".
    const binDir = path.join(TEST_DATA_DIR, "bin");
    const playbookDir = path.join(TEST_DATA_DIR, "playbooks");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(playbookDir, { recursive: true });
    fs.writeFileSync(path.join(playbookDir, "baseline.yml"), "- hosts: targets\n  tasks: []\n");
    const stats = JSON.stringify({ plays: [{ play: { name: "fixture" } }], stats: { h1: { ok: 3, changed: 1, failures: 0, unreachable: 0, skipped: 0 } } });
    fs.writeFileSync(path.join(binDir, "ansible-playbook"), `#!/bin/sh\necho '${stats}'\necho '[WARNING]: fixture deprecation {not json}' >&2\nexit 0\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
    const mainProfile = { endpoint, token_ref: "secret:proxmox_test_token", ca_pem: certPem, allow_lifecycle: true, task_poll_interval_ms: 300, task_timeout_ms: 5000, default: true };
    try {
      packLifecycle.configure("proxmox", {
        profiles: { main: mainProfile },
        ansible: { playbook_dir: playbookDir, allowed_playbooks: ["baseline.yml"] },
      });
      const det = json(await callInternalTool("ansible_run", { action: "detect" }));
      assert.strictEqual(det.ansible.state, "ready", JSON.stringify(det.ansible));
      const run = json(await callInternalTool("ansible_run", { action: "run", playbook: "baseline.yml", hosts: [{ alias: "h1", host: "10.0.0.9" }] }));
      assert.strictEqual(run.ok, true, JSON.stringify(run));
      assert.deepStrictEqual(run.hosts, ["h1"]);
      assert.deepStrictEqual(run.per_host.h1, { ok: 3, changed: 1, failures: 0, unreachable: 0 });
      // Success came from parsed stats: a stats block reporting a failure must
      // flip the verdict even though the process exits 0.
      fs.writeFileSync(path.join(binDir, "ansible-playbook"), `#!/bin/sh\necho '${JSON.stringify({ stats: { h1: { ok: 1, changed: 0, failures: 1, unreachable: 0 } } })}'\nexit 0\n`, { mode: 0o755 });
      const failed = json(await callInternalTool("ansible_run", { action: "run", playbook: "baseline.yml", hosts: [{ alias: "h1", host: "10.0.0.9" }] }));
      assert.strictEqual(failed.ok, false);
      assert.strictEqual(failed.code, "ansible_failed");
      assert.strictEqual(failed.per_host.h1.failures, 1);
    } finally {
      process.env.PATH = previousPath;
      packLifecycle.configure("proxmox", { profiles: { main: mainProfile } });
    }
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
