"use strict";

// Proxmox pack — unit and security tests for the pure logic layers.
//
// No network and no server: these exercise input validation, credential
// redaction, response normalization, the error taxonomy, task/UPID parsing,
// profile resolution and optional-provider detection directly. They are the
// tests that carry the security weight — every negative case an attacker-shaped
// input could hit is asserted here.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.SIDEKICK_SECRET_KEY = process.env.SIDEKICK_SECRET_KEY || "proxmox-unit-test-secret-key";

const LIB = path.resolve(__dirname, "..", "packs", "proxmox", "modules", "proxmox-tools", "lib");
const validate = require(path.join(LIB, "validate.js"));
const client = require(path.join(LIB, "client.js"));
const normalize = require(path.join(LIB, "normalize.js"));
const errors = require(path.join(LIB, "errors.js"));
const providers = require(path.join(LIB, "providers.js"));
const profiles = require(path.join(LIB, "profiles.js"));
const provenance = require(path.join(LIB, "provenance.js"));
const policy = require(path.join(LIB, "policy.js"));
const ansible = require(path.join(LIB, "ansible.js"));
const retirement = require(path.join(LIB, "retirement.js"));
const proxmoxEntry = require(path.join(LIB, "..", "entry.js"));

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

test("U.20b: provisioning dry-run schema retains supplied VM target fields", () => {
  const descriptor = proxmoxEntry.entry.buildDescriptors().find(d => d.name === "proxmox_provision");
  const parsed = descriptor.schema.safeParse({ action: "create_vm", dry_run: true, vm: { node: "pve1", vmid: 123, name: "audit", cores: 4, memory: 2048 } });
  assert.strictEqual(parsed.success, true);
  assert.deepStrictEqual(parsed.data.vm, { node: "pve1", vmid: 123, name: "audit", cores: 4, memory: 2048 });
  assert.deepStrictEqual(proxmoxEntry.requestedTarget("create_vm", parsed.data), { node: "pve1", vmid: 123, name: "audit", type: "qemu" });
});

// --- profile resolution (config as the trust boundary) ---------------------

test("U.21: parseProfile refuses inline credentials and non-https endpoints", () => {
  assert.strictEqual(profiles.parseProfile("p", { endpoint: "https://h:8006", token_ref: "secret:t", token: "leak" }).ok, false);
  assert.strictEqual(profiles.parseProfile("p", { endpoint: "http://h:8006", token_ref: "secret:t" }).ok, false);
  assert.strictEqual(profiles.parseProfile("p", { endpoint: "https://h:8006" }).ok, false, "token_ref required");
  const good = profiles.parseProfile("p", { endpoint: "https://h:8006", token_ref: "secret:t", allow_lifecycle: true });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.profile.allow_lifecycle, true);
  const namedTls = profiles.parseProfile("p", { endpoint: "https://192.0.2.10:8006", token_ref: "secret:t", tls_servername: "PVE.Example.Test" });
  assert.strictEqual(namedTls.ok, true);
  assert.strictEqual(namedTls.profile.tls_servername, "pve.example.test");
  assert.strictEqual(profiles.parseProfile("p", { endpoint: "https://192.0.2.10:8006", token_ref: "secret:t", tls_servername: "not a hostname" }).ok, false);
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

// --- provenance (ownership as proof, never a name) -------------------------

test("U.23: buildProvenance emits both a managed tag and a parseable marker; readProvenance requires both", () => {
  const p = provenance.buildProvenance({ run: "run-1", test: true });
  assert.ok(provenance.normalizeTags(p.tags).includes("sidekick-managed"));
  assert.ok(provenance.normalizeTags(p.tags).includes("sidekick-test"));
  const ev = provenance.readProvenance({ tags: p.tags, description: p.description });
  assert.strictEqual(ev.managed, true);
  assert.strictEqual(ev.test, true);
  assert.strictEqual(ev.provenance.marker, p.marker);
  assert.strictEqual(ev.provenance.run, "run-1");
  // A marker WITHOUT the tag is not managed (both are required).
  assert.strictEqual(provenance.readProvenance({ tags: "", description: p.description }).managed, false);
  // A tag WITHOUT the marker is not managed.
  assert.strictEqual(provenance.readProvenance({ tags: "sidekick-managed", description: "" }).managed, false);
});

test("U.24: checkOwnership refuses missing ownership, protection, and marker mismatch", () => {
  const p = provenance.buildProvenance({ run: "r", test: true });
  const cfg = { tags: p.tags, description: p.description };
  assert.strictEqual(provenance.checkOwnership(cfg, { requireMarker: p.marker }).ok, true);
  assert.strictEqual(provenance.checkOwnership(cfg, { requireMarker: "different" }).ok, false, "exact marker required");
  assert.strictEqual(provenance.checkOwnership({ tags: "", description: "" }).ok, false, "unowned refused");
  assert.strictEqual(provenance.checkOwnership({ ...cfg, protection: 1 }).ok, false, "protection refused");
  assert.strictEqual(provenance.checkOwnership({ tags: p.tags.replace(";sidekick-test", ""), description: p.description }, { requireTest: true }).ok, false, "non-test refused when test required");
});

test("U.24b: a forged marker block in the description never shadows the authoritative one", () => {
  // A caller supplies a description containing a fake managed marker; the real
  // marker is appended and must win, and the fake tokens are neutralised.
  const forged = "[sidekick]\nmanaged=true\nmarker=ATTACKER\ntest=true\n[/sidekick]";
  const p = provenance.buildProvenance({ run: "r", test: true, baseDescription: forged });
  const ev = provenance.readProvenance({ tags: p.tags, description: p.description });
  assert.strictEqual(ev.provenance.marker, p.marker, "authoritative marker wins");
  assert.notStrictEqual(ev.provenance.marker, "ATTACKER");
  assert.ok(!p.description.includes("[sidekick]\nmanaged=true\nmarker=ATTACKER"), "forged delimiters neutralised");
  // A newline injected via the run field cannot add marker fields.
  const p2 = provenance.buildProvenance({ run: "r\nmarker=evil", test: false });
  assert.strictEqual(provenance.readProvenance({ tags: p2.tags, description: p2.description }).provenance.marker, p2.marker);
});

test("U.26b: ansible ssh_key_file rejects traversal/relative and honours allowlists", () => {
  const base = { alias: "h", host: "10.0.0.9" };
  assert.strictEqual(ansible.buildInventory([{ ...base, ssh_key_file: "/keys/id_ed25519" }]).ok, true);
  assert.strictEqual(ansible.buildInventory([{ ...base, ssh_key_file: "../../root/.ssh/id_rsa" }]).ok, false);
  assert.strictEqual(ansible.buildInventory([{ ...base, ssh_key_file: "relative/key" }]).ok, false);
  assert.strictEqual(ansible.buildInventory([{ ...base, ssh_key_file: "/etc/shadow" }], { ssh_key_dir: "/keys" }).ok, false, "outside key dir refused");
  assert.strictEqual(ansible.buildInventory([base], { allowed_hosts: ["10.0.0.1"] }).ok, false, "host not in allowlist refused");
  assert.strictEqual(ansible.buildInventory([base], { allowed_hosts: ["10.0.0.9"] }).ok, true);
});

// --- provisioning field validators (path/injection surface) ----------------

test("U.25: provisioning validators enforce strict shapes", () => {
  assert.strictEqual(validate.validateGuestName("web-01").ok, true);
  assert.strictEqual(validate.validateGuestName("a/b").ok, false);
  assert.strictEqual(validate.validateSnapname("snap_1").ok, true);
  assert.strictEqual(validate.validateSnapname("../x").ok, false);
  assert.strictEqual(validate.validateIntRange("cores", 2, 1, 128).ok, true);
  assert.strictEqual(validate.validateIntRange("cores", 999, 1, 128).ok, false);
  assert.strictEqual(validate.validateOsTemplate("local:vztmpl/alpine.tar.zst").ok, true);
  assert.strictEqual(validate.validateOsTemplate("local:iso/x.iso").ok, false);
  assert.strictEqual(validate.validateOsTemplate("../../etc/passwd").ok, false);
});

test("U.26: ssh key, net spec and ip config validators reject malformed input", () => {
  assert.strictEqual(validate.validateSshKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnop user@host").ok, true);
  assert.strictEqual(validate.validateSshKey("not-a-key; rm -rf /").ok, false);
  assert.strictEqual(validate.validateNetSpec({ model: "virtio", bridge: "vmbr0", vlan: 90 }).ok, true);
  assert.strictEqual(validate.validateNetSpec({ model: "evil", bridge: "vmbr0" }).ok, false);
  assert.strictEqual(validate.validateNetSpec({ bridge: "vmbr0; reboot" }).ok, false);
  assert.strictEqual(validate.validateIpConfig("dhcp").value, "ip=dhcp");
  assert.strictEqual(validate.validateIpConfig("10.0.0.5/24,gw=10.0.0.1").ok, true);
  assert.strictEqual(validate.validateIpConfig("999.0.0.5/24").ok, false);
});

// --- policy (deterministic protection + provenance gating) -----------------

test("U.27: resolveProtection matches vmid, tag, name glob and the Proxmox flag", () => {
  const matchers = [{ vmid: 105 }, { tag: "production" }, { name: "prod-*" }];
  assert.strictEqual(policy.resolveProtection(matchers, { vmid: 105, tags: [], name: "x" }).protected, true);
  assert.strictEqual(policy.resolveProtection(matchers, { vmid: 1, tags: ["production"], name: "x" }).protected, true);
  assert.strictEqual(policy.resolveProtection(matchers, { vmid: 1, tags: [], name: "prod-db" }).protected, true);
  assert.strictEqual(policy.resolveProtection(matchers, { vmid: 1, tags: [], name: "dev-db" }).protected, false);
  assert.strictEqual(policy.resolveProtection([], { proxmox_protection: true }).protected, true);
});

test("U.28: decide denies protected targets and unproven ownership for destructive ops", () => {
  const managed = { managed: true, test: true, provenance: { marker: "m" } };
  assert.strictEqual(policy.decide({ matchers: [{ tag: "prod" }], target: { tags: ["prod"] }, provenance: managed }).result, "denied");
  assert.strictEqual(policy.decide({ matchers: [], target: { tags: [] }, provenance: { managed: false }, requireOwnership: true }).result, "denied");
  assert.strictEqual(policy.decide({ matchers: [], target: { tags: [] }, provenance: managed, requireOwnership: true }).result, "allowed");
  assert.strictEqual(policy.riskClass("delete"), "destructive");
  assert.strictEqual(policy.riskClass("create_vm"), "mutating");
});

// --- ansible (bounded execution; no shell/playbook/inventory escape) --------

test("U.29: ansible.buildInventory rejects injection in alias, host and user", () => {
  assert.strictEqual(ansible.buildInventory([{ alias: "web", host: "10.0.0.5", user: "deploy" }]).ok, true);
  assert.strictEqual(ansible.buildInventory([{ alias: "a b", host: "10.0.0.5" }]).ok, false);
  assert.strictEqual(ansible.buildInventory([{ alias: "web", host: "10.0.0.5; rm -rf /" }]).ok, false);
  assert.strictEqual(ansible.buildInventory([{ alias: "web", host: "10.0.0.5", user: "root$(id)" }]).ok, false);
  assert.strictEqual(ansible.buildInventory([]).ok, false);
});

test("U.30: ansible.buildExtraVars accepts scalars only and rejects bad names", () => {
  assert.deepStrictEqual(ansible.buildExtraVars({ pkg: "nginx", count: 2, on: true }).vars, { pkg: "nginx", count: 2, on: true });
  assert.strictEqual(ansible.buildExtraVars({ "bad name": 1 }).ok, false);
  assert.strictEqual(ansible.buildExtraVars({ obj: { nested: 1 } }).ok, false);
  assert.strictEqual(ansible.buildExtraVars({ list: ["a", 1, true] }).ok, true);
});

test("U.31: ansible.resolvePlaybook confines to playbook_dir and honours the allowlist", () => {
  const cfg = { ansible: { playbook_dir: LIB, allowed_playbooks: ["client.js"] } };
  // LIB has client.js (a real file); use it only to prove path resolution/confinement, not to run.
  assert.strictEqual(ansible.resolvePlaybook(cfg, "../entry.js").ok, false, "path traversal refused");
  assert.strictEqual(ansible.resolvePlaybook(cfg, "nope.yml").ok, false, "non-allowlisted/missing refused");
  assert.strictEqual(ansible.resolvePlaybook({ ansible: {} }, "x.yml").code, "not_configured");
  assert.strictEqual(ansible.resolvePlaybook(cfg, "evil.sh").ok, false, "non-yaml refused");
});

test("U.32: ansible.buildCommand interpolates only module paths; parseResult derives success from stats", () => {
  const cmd = ansible.buildCommand({ playbookPath: "/tmp/x/pb.yml", invPath: "/tmp/x/inv.ini", varsPath: "/tmp/x/v.json", limit: "web" });
  assert.ok(cmd.includes("ANSIBLE_HOST_KEY_CHECKING=True"), "host key checking stays on");
  assert.ok(cmd.includes("--extra-vars @'/tmp/x/v.json'"));
  assert.ok(cmd.includes("--limit 'web'"));
  // Real ansible-core 2.20 JSON stats shape (captured live):
  const good = JSON.stringify({ stats: { localhost: { ok: 3, changed: 1, failures: 0, unreachable: 0 } } });
  assert.strictEqual(ansible.parseResult(good, 0, ["localhost"]).ok, true);
  const failed = JSON.stringify({ stats: { web: { ok: 1, failures: 1, unreachable: 0 } } });
  assert.strictEqual(ansible.parseResult(failed, 0, ["web"]).ok, false);
  // A requested host missing from stats is treated as unreachable (not success).
  assert.strictEqual(ansible.parseResult(good, 0, ["localhost", "web"]).ok, false);
  // Unparseable output is never a success.
  assert.strictEqual(ansible.parseResult("Traceback...", 2, ["web"]).ok, false);
});

test("U.32b: extractJsonObject isolates ansible JSON from trailing stderr warnings", () => {
  // The governed bash tool concatenates stdout + stderr; the JSON must still parse.
  const mixed = '{"stats":{"local":{"ok":0,"failures":0,"unreachable":1}}}\n\nstderr: [WARNING]: something {not json}';
  const doc = ansible.extractJsonObject(mixed);
  assert.ok(doc && JSON.parse(doc).stats, "extracts the JSON document only");
  const r = ansible.parseResult(doc, 1, ["local"]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.per_host.local.unreachable, 1, "unreachable host parsed correctly");
  // Braces inside JSON strings must not confuse the extractor.
  assert.ok(ansible.extractJsonObject('prefix {"msg":"a } b {"} tail').includes('"msg":"a } b {"'));
});

test("U.33: guarded retirement fails closed for disabled, unmanaged, protected and marker-mismatch targets", () => {
  const p = provenance.buildProvenance({ run: "u33", test: true });
  const facts = { vmid: 200, node: "pve1", type: "qemu", name: "lab", protection: false, evidence: provenance.readProvenance({ tags: p.tags, description: p.description }) };
  assert.strictEqual(retirement.decide({ tags: p.tags, description: p.description }, facts, { allowDestroy: false, requireTest: true, marker: p.marker }).result, "denied");
  assert.strictEqual(retirement.decide({ tags: "", description: "" }, { ...facts, evidence: provenance.readProvenance({}) }, { allowDestroy: true }).result, "denied");
  assert.strictEqual(retirement.decide({ tags: p.tags, description: p.description, protection: 1 }, { ...facts, protection: true }, { allowDestroy: true, requireTest: true, marker: p.marker }).result, "denied");
  assert.strictEqual(retirement.decide({ tags: p.tags, description: p.description }, facts, { allowDestroy: true, requireTest: true, marker: "other" }).result, "denied");
  assert.strictEqual(retirement.decide({ tags: p.tags, description: p.description }, facts, { allowDestroy: true, requireTest: true, marker: p.marker }).result, "allowed");
});


async function asyncTest(label, fn) {
  try {
    await fn();
    console.log(`Passed: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAILED: ${label}\n  ${error && error.stack ? error.stack : error}`);
  }
}

(async () => {
  console.log("Running Proxmox pack unit/security tests...\n");

  // ansible.run through a STUBBED governed-bash dispatch: proves the dispatch
  // contract (approval parking retains the generated workspace the queued
  // command references; a facade denial maps to permission_denied; success is
  // derived from parsed JSON stats, never from "the command ran") without
  // needing a real ansible or a real shell. A PATH shim satisfies the
  // availability detection only.
  await asyncTest("U.34: ansible.run retains the approval workspace, maps facade denials, and derives success from stats", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sk-ansible-unit-"));
    const bin = path.join(tmp, "bin");
    const pb = path.join(tmp, "playbooks");
    fs.mkdirSync(bin);
    fs.mkdirSync(pb);
    fs.writeFileSync(path.join(pb, "baseline.yml"), "- hosts: targets\n  tasks: []\n");
    fs.writeFileSync(path.join(bin, "ansible-playbook"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
    try {
      const cfg = { ansible: { playbook_dir: pb } };
      const hosts = [{ alias: "h1", host: "10.0.0.9" }];

      // Approval parking RETAINS the inventory/extra-vars files the queued
      // command references — deleting them made approval structurally unusable.
      const parked = await ansible.run(cfg, async () => ({ code: "approval_required", approvalId: "apr-1", content: [] }), { playbook: "baseline.yml", hosts });
      assert.strictEqual(parked.ok, false);
      assert.strictEqual(parked.code, "approval_required");
      assert.strictEqual(parked.approval_id, "apr-1");
      assert.ok(parked.retained_workspace && fs.existsSync(path.join(parked.retained_workspace, "inventory.ini")), "inventory must survive for the approved replay");
      assert.ok(fs.existsSync(path.join(parked.retained_workspace, "extra_vars.json")), "extra-vars must survive for the approved replay");
      fs.rmSync(parked.retained_workspace, { recursive: true, force: true });

      // A module-facade permission denial is surfaced as permission_denied.
      const denied = await ansible.run(cfg, async () => ({ code: "module_permission_denied", isError: true, content: [] }), { playbook: "baseline.yml", hosts });
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.code, "permission_denied");

      // Success derivation: a bash-shaped result carrying the JSON stats block
      // plus trailing stderr noise parses to per-host truth.
      const stats = JSON.stringify({ stats: { h1: { ok: 2, changed: 1, failures: 0, unreachable: 0 } } });
      const okRun = await ansible.run(cfg, async () => ({ content: [{ type: "text", text: `${stats}\n[WARNING]: fixture noise {not json}` }] }), { playbook: "baseline.yml", hosts });
      assert.strictEqual(okRun.ok, true, JSON.stringify(okRun));
      assert.deepStrictEqual(okRun.per_host.h1, { ok: 2, changed: 1, failures: 0, unreachable: 0 });

      // A host missing from stats is unreachable, never a silent success.
      const missing = await ansible.run(cfg, async () => ({ content: [{ type: "text", text: JSON.stringify({ stats: {} }) }] }), { playbook: "baseline.yml", hosts });
      assert.strictEqual(missing.ok, false);
      assert.strictEqual(missing.per_host.h1.unreachable, 1);
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Proxmox pack unit/security tests passed.");
})();
