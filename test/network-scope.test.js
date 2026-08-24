"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-network-scope-"));
process.env.SIDEKICK_DATA_DIR = dir;
process.env.SIDEKICK_DB_FILE = path.join(dir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "network-scope-test-secret";
require("../src/db").runPendingMigrations();

const policy = require("../src/security/network-scope");
const scopes = require("../src/security/network-scopes");

function test(name, fn) { try { fn(); console.log(`Passed: ${name}`); } catch (error) { console.error(`FAILED: ${name}\n${error.stack}`); process.exitCode = 1; } }

test("normalizes equivalent CIDRs, hosts, protocols and ranges deterministically", () => {
  const a = policy.normalizeScope({ name: "lab_scope", allowed_cidrs: ["10.47.90.11/24"], allowed_hosts: ["*.Example.Test."], allowed_protocols: ["HTTPS", "http", "https"], allowed_ports: [443, "80-81", 80], allow_private_addresses: true });
  const b = policy.normalizeScope({ name: "lab_scope", allowed_cidrs: ["10.47.90.0/24"], allowed_hosts: ["*.example.test"], allowed_protocols: ["http", "https"], allowed_ports: ["80-81", 443], allow_private_addresses: true });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.digest.length, 64);
});

test("rejects ambiguous wildcard, credentials-shaped fields, and unbounded input", () => {
  const base = { allowed_protocols: ["https"] };
  assert.throws(() => policy.normalizeScope({ ...base, name: "bad_scope", allowed_hosts: ["*"] }), /wildcard|hostname|allowlist/);
  assert.throws(() => policy.normalizeScope({ ...base, name: "bad_scope", allowed_hosts: ["*.com"] }), /wildcard/);
  assert.throws(() => policy.normalizeScope({ ...base, name: "bad_scope", allowed_hosts: ["ok.example"], username: "secret" }), /unknown|credential|object|allowlist/);
});

test("permanent denials and explicit denials override allows", () => {
  const scope = policy.normalizeScope({ name: "denial_scope", allowed_cidrs: ["0.0.0.0/0", "::/0"], allowed_hosts: ["*.example.test"], allowed_protocols: ["http"], denied_cidrs: ["10.47.20.0/24"], allow_private_addresses: true });
  assert.strictEqual(policy.decision(scope, { address: "10.47.20.5", protocol: "http", port: 80 }).reason, "explicit_address_denial");
  assert.strictEqual(policy.decision(scope, { address: "169.254.169.254", protocol: "http", port: 80 }).reason, "permanent_denial");
  assert.strictEqual(policy.decision(scope, { address: "::ffff:10.47.20.5", protocol: "http", port: 80 }).ok, false);
  assert.strictEqual(policy.decision(scope, { host: "api.example.test", address: "192.0.2.10", protocol: "http", port: 80 }).ok, true);
  assert.strictEqual(policy.decision(scope, { host: "api.example.test", address: "192.0.2.10", protocol: "https", port: 443 }).reason, "protocol_not_allowed");
  assert.strictEqual(policy.decision(scope, { address: "fe80::1", protocol: "http", port: 80 }).reason, "permanent_denial");
});

test("named scopes persist immutable revisions and disable live authority", () => {
  const created = scopes.create({ name: "persisted_scope", allowed_ips: ["192.0.2.10"], allowed_protocols: ["https"], allowed_ports: [443] }, "operator");
  assert.strictEqual(created.revision, 1);
  const revised = scopes.update(created.scope_id, { allowed_ips: ["192.0.2.11"], allowed_protocols: ["https"], allowed_ports: [443] }, "operator");
  assert.strictEqual(revised.revision, 2);
  assert.strictEqual(scopes.get(created.scope_id, 1).digest, created.digest);
  assert.notStrictEqual(revised.digest, created.digest);
  const disabled = scopes.setState(created.scope_id, "disabled", "operator");
  assert.strictEqual(disabled.enabled, false);
});

test("disabled creation and revision changes never expose live authority", () => {
  const disabled = scopes.create({ name: "disabled_scope", enabled: false, allowed_ips: ["192.0.2.20"], allowed_protocols: ["https"], allowed_ports: [443] }, "operator");
  assert.strictEqual(disabled.enabled, false);
  const active = scopes.create({ name: "revocation_scope", allowed_ips: ["192.0.2.21"], allowed_protocols: ["https"], allowed_ports: [443] }, "operator");
  const old = scopes.get(active.scope_id, 1);
  scopes.update(active.scope_id, { allowed_ips: ["192.0.2.22"], allowed_protocols: ["https"], allowed_ports: [443] }, "operator");
  assert.strictEqual(old.is_current, true);
  assert.strictEqual(scopes.get(active.scope_id, 1).is_current, false);
  assert.strictEqual(policy.decision(scopes.get(active.scope_id, 1), { address: "192.0.2.21", protocol: "https", port: 443 }).reason, "scope_superseded");
});

if (!process.exitCode) console.log("Named network scope tests passed");
