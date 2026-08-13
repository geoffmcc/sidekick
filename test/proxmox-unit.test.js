"use strict";

// Proxmox pack — unit and security tests for the pure logic layers.
//
// No network and no server: these exercise input validation, credential
// redaction, response normalization, the error taxonomy, task/UPID parsing,
// profile resolution and optional-provider detection directly. They are the
// tests that carry the security weight — every negative case an attacker-shaped
// input could hit is asserted here.

const assert = require("assert");
const path = require("path");

process.env.SIDEKICK_SECRET_KEY = process.env.SIDEKICK_SECRET_KEY || "proxmox-unit-test-secret-key";

const LIB = path.resolve(__dirname, "..", "packs", "proxmox", "modules", "proxmox-tools", "lib");
const validate = require(path.join(LIB, "validate.js"));
const client = require(path.join(LIB, "client.js"));
const normalize = require(path.join(LIB, "normalize.js"));
const errors = require(path.join(LIB, "errors.js"));
const providers = require(path.join(LIB, "providers.js"));
const profiles = require(path.join(LIB, "profiles.js"));

let failures = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`Passed: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAILED: ${label}\n  ${error && error.stack ? error.stack : error}`);
  }
}

// --- endpoint validation (SSRF surface) ------------------------------------

test("U.1: validateEndpoint accepts a bare https origin and reports host/port", () => {
  const r = validate.validateEndpoint("https://pve.example.invalid:8006");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, "https://pve.example.invalid:8006");
  assert.strictEqual(r.hostname, "pve.example.invalid");
  assert.strictEqual(r.port, 8006);
});

test("U.2: validateEndpoint rejects cleartext http (tokens must not travel over http)", () => {
  assert.strictEqual(validate.validateEndpoint("http://pve.example.invalid:8006").ok, false);
});

test("U.3: validateEndpoint rejects a path, query, fragment or embedded credentials", () => {
  for (const bad of [
    "https://pve.example.invalid:8006/api2/json",
    "https://pve.example.invalid:8006/?x=1",
    "https://pve.example.invalid:8006/#frag",
    "https://user:pass@pve.example.invalid:8006",
  ]) {
    assert.strictEqual(validate.validateEndpoint(bad).ok, false, `should reject ${bad}`);
  }
});

test("U.4: validateEndpoint rejects link-local and cloud-metadata hosts", () => {
  assert.strictEqual(validate.validateEndpoint("https://169.254.169.254:8006").ok, false);
  assert.strictEqual(validate.validateEndpoint("https://metadata.google.internal:8006").ok, false);
});

test("U.5: validateEndpoint allows private/RFC1918 hosts (homelab Proxmox is first-class)", () => {
  assert.strictEqual(validate.validateEndpoint("https://10.0.0.5:8006").ok, true);
  assert.strictEqual(validate.validateEndpoint("https://192.168.1.10:8006").ok, true);
});

test("U.5b: validateEndpoint preserves an explicit port, including the default 443", () => {
  // WHATWG URL elides :443; the endpoint must still target 443, not 8006.
  const p443 = validate.validateEndpoint("https://pve.example.invalid:443");
  assert.strictEqual(p443.ok, true);
  assert.strictEqual(p443.port, 443);
  assert.strictEqual(p443.value, "https://pve.example.invalid:443");
  // No explicit port falls back to the Proxmox default 8006.
  const pDefault = validate.validateEndpoint("https://pve.example.invalid");
  assert.strictEqual(pDefault.port, 8006);
  // A non-default explicit port is preserved.
  assert.strictEqual(validate.validateEndpoint("https://pve.example.invalid:8006").port, 8006);
});

// --- identifier validation (path-injection surface) ------------------------

test("U.6: validateVmid enforces the integer range and rejects injection", () => {
  assert.strictEqual(validate.validateVmid(100).ok, true);
  assert.strictEqual(validate.validateVmid("105").ok, true);
  assert.strictEqual(validate.validateVmid(99).ok, false);
  assert.strictEqual(validate.validateVmid(1e12).ok, false);
  assert.strictEqual(validate.validateVmid("../105").ok, false);
  assert.strictEqual(validate.validateVmid("105; rm -rf").ok, false);
  assert.strictEqual(validate.validateVmid("105/status").ok, false);
});

test("U.7: validateNodeName rejects path separators and shell metacharacters", () => {
  assert.strictEqual(validate.validateNodeName("pve1").ok, true);
  assert.strictEqual(validate.validateNodeName("a/b").ok, false);
  assert.strictEqual(validate.validateNodeName("../etc").ok, false);
  assert.strictEqual(validate.validateNodeName("node;reboot").ok, false);
  assert.strictEqual(validate.validateNodeName("node name").ok, false);
});

test("U.8: validateStorageId and validateProfileName enforce strict shapes", () => {
  assert.strictEqual(validate.validateStorageId("local-lvm").ok, true);
  assert.strictEqual(validate.validateStorageId("../x").ok, false);
  assert.strictEqual(validate.validateProfileName("production").ok, true);
  assert.strictEqual(validate.validateProfileName("Prod!").ok, false);
  assert.strictEqual(validate.validateProfileName("../../x").ok, false);
});

test("U.9: validateSecretRef only accepts secret:<name> references", () => {
  assert.strictEqual(validate.validateSecretRef("secret:proxmox_prod_token").ok, true);
  assert.strictEqual(validate.validateSecretRef("root@pam!t=uuid").ok, false);
  assert.strictEqual(validate.validateSecretRef("secret:").ok, false);
});

// --- UPID parsing (task path-injection surface) ----------------------------

test("U.10: parseUpid accepts a canonical UPID and extracts fields", () => {
  const upid = "UPID:pve1:0000040D:00000638:6A7DE437:startall::root@pam:";
  const r = validate.parseUpid(upid);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.node, "pve1");
  assert.strictEqual(r.type, "startall");
  assert.strictEqual(r.user, "root@pam");
});

test("U.11: parseUpid rejects malformed or injection-shaped task ids", () => {
  for (const bad of [
    "UPID:pve1:0000040D",                 // too few fields
    "not-a-upid",
    "UPID:pve1:xyz:00:00:t:i:u:",          // non-hex pid
    "UPID:pve1:1:1:1:t:i:u",               // missing trailing colon
    "UPID:pve1:1:1:1:t:i:u:/../../x",      // slash injection
    "UPID:pve a:1:1:1:t:i:u:",              // space
  ]) {
    assert.strictEqual(validate.parseUpid(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

// --- credential redaction --------------------------------------------------

test("U.12: scrubSecrets removes the literal token, PVEAPIToken and Authorization", () => {
  const token = "root@pam!ci=1234abcd-5678-90ef-ghij-klmnopqrstuv";
  const text = `error: bad request with Authorization: PVEAPIToken=${token} rejected; header PVEAPIToken=${token}`;
  const scrubbed = client.scrubSecrets(text, token);
  assert.ok(!scrubbed.includes(token), "literal token must be gone");
  assert.ok(!scrubbed.includes("1234abcd"), "token secret substring must be gone");
  assert.ok(scrubbed.includes("[REDACTED]"));
});

test("U.13: buildApiPath keeps UPID punctuation literal but escapes slashes", () => {
  const p = client.buildApiPath(["nodes", "pve1", "tasks", "UPID:pve1:1:1:1:t:i:root@pam!tok:", "status"]);
  assert.ok(p.includes("UPID:pve1:1:1:1:t:i:root@pam!tok:"), `colons/@/! preserved: ${p}`);
  // a slash inside a segment must be percent-encoded, never a real separator
  const p2 = client.buildApiPath(["storage", "local/evil"]);
  assert.ok(p2.includes("local%2Fevil"), `slash escaped: ${p2}`);
  assert.throws(() => client.buildApiPath(["nodes", ""]), /Empty API path segment/);
});

// --- normalization (real-hardware shape tolerance) -------------------------

test("U.14: num and bool tolerate string numbers and 0/1/\"0\"/\"1\" booleans", () => {
  assert.strictEqual(normalize.num("508"), 508);
  assert.strictEqual(normalize.num(0.5), 0.5);
  assert.strictEqual(normalize.num("nope"), null);
  assert.strictEqual(normalize.bool(1), true);
  assert.strictEqual(normalize.bool("1"), true);
  assert.strictEqual(normalize.bool("0"), false);
  assert.strictEqual(normalize.bool(0), false);
});

test("U.15: taskOutcome derives success from exitstatus and treats WARNINGS as ok", () => {
  assert.deepStrictEqual(normalize.taskOutcome({ status: "stopped", exitstatus: "OK" }), { running: false, ok: true, exitstatus: "OK" });
  assert.strictEqual(normalize.taskOutcome({ status: "stopped", exitstatus: "WARNINGS: 1" }).ok, true);
  assert.strictEqual(normalize.taskOutcome({ status: "stopped", exitstatus: "command failed" }).ok, false);
  assert.strictEqual(normalize.taskOutcome({ status: "running" }).running, true);
  // list-row form: outcome lives in status when exitstatus is absent
  assert.strictEqual(normalize.taskOutcome({ status: "OK" }).ok, true);
});

test("U.16: normalizeClusterStatus distinguishes cluster from standalone", () => {
  const cluster = normalize.normalizeClusterStatus([
    { type: "cluster", name: "pvetest", nodes: 2, quorate: 1 },
    { type: "node", name: "pve1", online: 1, ip: "10.0.0.11", local: 1 },
    { type: "node", name: "pve2", online: 1, ip: "10.0.0.12", local: 0 },
  ]);
  assert.strictEqual(cluster.mode, "cluster");
  assert.strictEqual(cluster.quorate, true);
  assert.strictEqual(cluster.online_nodes, 2);
  const standalone = normalize.normalizeClusterStatus([{ type: "node", name: "pve", online: 1, local: 1 }]);
  assert.strictEqual(standalone.mode, "standalone");
});

test("U.17: detectCloudInit recognises a cloud-init drive or cloud-init keys", () => {
  assert.strictEqual(normalize.detectCloudInit({ ide2: "local:vm-100-cloudinit,media=cdrom" }), true);
  assert.strictEqual(normalize.detectCloudInit({ ipconfig0: "ip=dhcp" }), true);
  assert.strictEqual(normalize.detectCloudInit({ scsi0: "local-lvm:vm-100-disk-0" }), false);
});

// --- error taxonomy --------------------------------------------------------

test("U.18: classifyNetworkError maps node error codes to distinct categories", () => {
  assert.strictEqual(errors.classifyNetworkError({ code: "ENOTFOUND" }, "h").code, "dns_failure");
  assert.strictEqual(errors.classifyNetworkError({ code: "ECONNREFUSED" }, "h").code, "connection_refused");
  assert.strictEqual(errors.classifyNetworkError({ code: "ETIMEDOUT" }, "h").code, "network_timeout");
  assert.strictEqual(errors.classifyNetworkError({ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "h").code, "tls_failure");
  assert.strictEqual(errors.classifyNetworkError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "h").code, "tls_failure");
});

test("U.19: classifyHttpError separates auth, authorization and missing", () => {
  assert.strictEqual(errors.classifyHttpError(401, "").code, "auth_failed");
  assert.strictEqual(errors.classifyHttpError(403, "").code, "permission_denied");
  assert.strictEqual(errors.classifyHttpError(404, "").code, "resource_missing");
  assert.strictEqual(errors.classifyHttpError(500, "config does not exist").code, "resource_missing");
  assert.strictEqual(errors.classifyHttpError(500, "something broke").code, "api_error");
});

// --- optional provider detection -------------------------------------------

test("U.20: detectProvider reports a missing binary as not_installed and never claims execution", () => {
  const r = providers.detectProvider("definitely-not-a-real-binary-xyz");
  assert.strictEqual(r.installed, false);
  assert.strictEqual(r.state, "not_installed");
  assert.strictEqual(r.execution, "not_implemented");
});

// --- profile resolution (config as the trust boundary) ---------------------

test("U.21: parseProfile refuses inline credentials and non-https endpoints", () => {
  assert.strictEqual(profiles.parseProfile("p", { endpoint: "https://h:8006", token_ref: "secret:t", token: "leak" }).ok, false);
  assert.strictEqual(profiles.parseProfile("p", { endpoint: "http://h:8006", token_ref: "secret:t" }).ok, false);
  assert.strictEqual(profiles.parseProfile("p", { endpoint: "https://h:8006" }).ok, false, "token_ref required");
  const good = profiles.parseProfile("p", { endpoint: "https://h:8006", token_ref: "secret:t", allow_lifecycle: true });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.profile.allow_lifecycle, true);
});

test("U.22: resolveProfile handles default, ambiguity and unknown names", () => {
  const cfg = { profiles: { a: { endpoint: "https://a:8006", token_ref: "secret:a" }, b: { endpoint: "https://b:8006", token_ref: "secret:b", default: true } } };
  assert.strictEqual(profiles.resolveProfile(cfg, "a").ok, true);
  assert.strictEqual(profiles.resolveProfile(cfg, "b").profile.name, "b");
  assert.strictEqual(profiles.resolveProfile(cfg).profile.name, "b", "default is chosen when unspecified");
  assert.strictEqual(profiles.resolveProfile(cfg, "missing").code, "profile_not_found");
  assert.strictEqual(profiles.resolveProfile({ profiles: {} }).code, "not_configured");
  const ambiguous = { profiles: { a: { endpoint: "https://a:8006", token_ref: "secret:a" }, b: { endpoint: "https://b:8006", token_ref: "secret:b" } } };
  assert.strictEqual(profiles.resolveProfile(ambiguous).code, "profile_required");
});

(async () => {
  console.log("Running Proxmox pack unit/security tests...\n");
  // (all synchronous; wrapper kept for parity with other suites)
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Proxmox pack unit/security tests passed.");
})();
