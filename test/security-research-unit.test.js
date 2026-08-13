"use strict";

/**
 * Security Research pack — unit / boundary tests (no DB, no I/O beyond a temp
 * dir). Exercises the workspace boundary, probe scope/SSRF gating, deterministic
 * comparison, and a self-scan proving the pack tree carries no developer paths
 * or secrets. Labels U.1…
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PACK_ROOT = path.resolve(__dirname, "..", "packs", "security-research");
const LIB = path.join(PACK_ROOT, "modules", "security-research-tools", "lib");
const workspace = require(path.join(LIB, "workspace.js"));
const compare = require(path.join(LIB, "compare.js"));
const probes = require(path.join(LIB, "probes.js"));
const { ResearchError } = require(path.join(LIB, "errors.js"));

let failures = 0;
function test(label, fn) {
  try { fn(); console.log(`Passed: ${label}`); }
  catch (e) { failures += 1; console.error(`FAILED: ${label}\n  ${e && e.stack ? e.stack : e}`); }
}
function expectResearchError(code, fn) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof ResearchError, `expected ResearchError, got ${e && e.name}`);
    assert.strictEqual(e.code, code, `expected code ${code}, got ${e.code}`);
    return;
  }
  throw new Error(`expected ResearchError(${code}) but no error was thrown`);
}

const REPO_ROOT = path.resolve(__dirname, "..");
const externalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "sr-unit-ws-"));

// --- workspace boundary -----------------------------------------------------

test("U.1 accepts an external absolute workspace", () => {
  const resolved = workspace.resolveWorkspace({ workspace: externalWorkspace });
  assert.strictEqual(resolved.source, "config");
  assert.ok(path.isAbsolute(resolved.root));
});

test("U.2 rejects the Sidekick repository root as workspace", () => {
  expectResearchError("workspace_unsafe", () => workspace.resolveWorkspace({ workspace: REPO_ROOT }));
});

test("U.3 rejects a directory inside the Sidekick repository", () => {
  expectResearchError("workspace_unsafe", () => workspace.resolveWorkspace({ workspace: path.join(REPO_ROOT, "src") }));
});

test("U.4 rejects a workspace that is a PARENT of the repository", () => {
  expectResearchError("workspace_unsafe", () => workspace.resolveWorkspace({ workspace: path.dirname(REPO_ROOT) }));
});

test("U.5 rejects a relative workspace path", () => {
  expectResearchError("workspace_unsafe", () => workspace.resolveWorkspace({ workspace: "relative/research" }));
});

test("U.6 fails closed with workspace_missing when nothing is configured", () => {
  const savedEnv = process.env.SIDEKICK_RESEARCH_WORKSPACE;
  delete process.env.SIDEKICK_RESEARCH_WORKSPACE;
  try { expectResearchError("workspace_missing", () => workspace.resolveWorkspace({})); }
  finally { if (savedEnv !== undefined) process.env.SIDEKICK_RESEARCH_WORKSPACE = savedEnv; }
});

test("U.7 reads the workspace from SIDEKICK_RESEARCH_WORKSPACE", () => {
  const saved = process.env.SIDEKICK_RESEARCH_WORKSPACE;
  process.env.SIDEKICK_RESEARCH_WORKSPACE = externalWorkspace;
  try {
    const resolved = workspace.resolveWorkspace({});
    assert.strictEqual(resolved.source, "environment");
  } finally {
    if (saved === undefined) delete process.env.SIDEKICK_RESEARCH_WORKSPACE; else process.env.SIDEKICK_RESEARCH_WORKSPACE = saved;
  }
});

test("U.8 canonicalizes a symlink that escapes into the repository and rejects it", () => {
  const link = path.join(externalWorkspace, "escape-link");
  try { fs.rmSync(link, { force: true }); } catch {}
  fs.symlinkSync(REPO_ROOT, link);
  expectResearchError("workspace_unsafe", () => workspace.resolveWorkspace({ workspace: link }));
});

test("U.9 rejects a dangerously shallow workspace (the OS temp root)", () => {
  expectResearchError("workspace_unsafe", () => workspace.resolveWorkspace({ workspace: os.tmpdir() }));
});

test("U.10 confines writes to inside the workspace and refuses traversal", () => {
  const wrote = workspace.atomicWrite(externalWorkspace, path.join(externalWorkspace, "a", "b.json"), "{}");
  assert.ok(fs.existsSync(wrote.path));
  expectResearchError("evidence_write_failed", () => workspace.atomicWrite(externalWorkspace, path.join(externalWorkspace, "..", "evil.txt"), "x"));
});

test("U.11 safeSegment rejects path traversal ids", () => {
  expectResearchError("invalid_input", () => workspace.safeSegment("../etc", "run_id"));
  assert.strictEqual(workspace.safeSegment("test_run_abc-123", "run_id"), "test_run_abc-123");
});

// --- probe gating (no DB path) ---------------------------------------------

test("U.12 SSRF guard flags private/loopback literals across encodings", () => {
  const priv = [
    "127.0.0.1", "localhost", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.1.1", "::1", "[::1]", "::",
    // IPv4-mapped IPv6, and decimal/hex/octal/short-form IPv4 that all resolve to loopback/link-local:
    "[::ffff:169.254.169.254]", "[::ffff:7f00:1]", "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "10.1", "192.168.1",
  ];
  for (const host of priv) assert.strictEqual(probes.isPrivateHost(host), true, `${host} should be private`);
  for (const host of ["93.184.216.34", "lab.example.test", "8.8.8.8", "172.32.0.1"]) {
    assert.strictEqual(probes.isPrivateHost(host), false, `${host} should be public`);
  }
});

test("U.13 host allowlist matches globs", () => {
  assert.strictEqual(probes.hostMatchesAllowlist("api.example.test", ["*.example.test"]), true);
  assert.strictEqual(probes.hostMatchesAllowlist("evil.test", ["*.example.test"]), false);
  assert.strictEqual(probes.hostMatchesAllowlist("anything", []), false);
});

test("U.14 command probe on the host is denied unless local probes are enabled", () => {
  const ctx = { config: { allow_local_probes: false }, run: {}, environment: { kind: "local" } };
  expectResearchError("policy_denied", () => probes.gate(ctx, { type: "command", command: "echo hi" }));
  const ctxAllowed = { config: { allow_local_probes: true }, run: {}, environment: { kind: "local" } };
  const decision = probes.gate(ctxAllowed, { type: "command", command: "echo hi" });
  assert.strictEqual(decision.operation, "execute");
});

test("U.14b a command probe cannot be routed to a non-local environment (no host bypass)", () => {
  // Even with local probes enabled, a caller-supplied non-local kind must be
  // refused rather than silently running on the host under a 'remote' label.
  const ctx = { config: { allow_local_probes: true }, run: {}, environment: { kind: "remote" } };
  expectResearchError("unsupported_operation", () => probes.gate(ctx, { type: "command", command: "id" }));
  const ctxProxmox = { config: { allow_local_probes: true }, run: {}, environment: { kind: "proxmox" } };
  expectResearchError("unsupported_operation", () => probes.gate(ctxProxmox, { type: "command", command: "id" }));
});

test("U.15 http probe to a non-allowlisted host is scope_denied without a snapshot", () => {
  const ctx = { config: { http: { allowed_hosts: ["*.example.test"] } }, run: {}, environment: { kind: "remote" } };
  expectResearchError("scope_denied", () => probes.gate(ctx, { type: "http", url: "https://evil.test/x" }));
});

test("U.16 http probe to a private host is policy_denied unless explicitly allowed", () => {
  const ctx = { config: { http: { allowed_hosts: ["*"], allow_private_addresses: false } }, run: {}, environment: { kind: "remote" } };
  expectResearchError("policy_denied", () => probes.gate(ctx, { type: "http", url: "http://127.0.0.1/x" }));
});

// --- deterministic comparison ----------------------------------------------

test("U.17 status comparison detects change deterministically", () => {
  assert.strictEqual(compare.compareValues(403, 200, "status").changed, true);
  assert.strictEqual(compare.compareValues(200, 200, "status").changed, false);
});

test("U.18 hash comparison normalizes the sha256: prefix", () => {
  assert.strictEqual(compare.compareValues("sha256:ABC", "abc", "hash").changed, false);
});

test("U.19 json comparison reports changed key paths", () => {
  const r = compare.compareValues({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }, "json");
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.details.changed_paths, ["b.c"]);
});

test("U.20 validation verdict is deterministic", () => {
  assert.strictEqual(compare.validateExpectation("status:403", "status:403", "status").matched, true);
  assert.strictEqual(compare.validateExpectation("status:403", "status:200", "status").matched, false);
});

// --- leakage self-scan of the pack tree ------------------------------------

test("U.21 the pack tree contains no developer paths or obvious secrets", () => {
  const forbidden = [
    { re: /\/home\/[a-z][a-z0-9_-]*\//, name: "unix home directory path" },
    { re: /[A-Za-z]:\\Users\\/, name: "windows user directory path" },
    { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, name: "private key" },
    { re: /ghp_[A-Za-z0-9]{36}/, name: "github token" },
    { re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{8,}/i, name: "bearer token" },
  ];
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      const text = fs.readFileSync(p, "utf8");
      for (const rule of forbidden) {
        if (rule.re.test(text)) offenders.push(`${path.relative(PACK_ROOT, p)}: ${rule.name}`);
      }
    }
  })(PACK_ROOT);
  assert.deepStrictEqual(offenders, [], `pack tree leaked: ${offenders.join(", ")}`);
});

// cleanup
try { fs.rmSync(externalWorkspace, { recursive: true, force: true }); } catch {}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll security-research unit tests passed");
process.exit(0);
