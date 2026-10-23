"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-security-boundaries-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = "";
process.env.SIDEKICK_SECRET_KEY = "security-boundaries-test-secret-key";

const db = require("../../src/db");
const legacyTools = require("../../src/tools-legacy");
const identity = require("../../src/core/identity");
const authorization = require("../../src/core/authorization");
const securityAudit = require("../../src/core/security-audit");
const context = require("../../src/tools/context");
const dispatcher = require("../../src/tools/dispatcher");
const tools = require("../../src/tools");
const { normalizeDefinition } = require("../../src/workflows/definition");
const packLifecycle = require("../../src/packs/lifecycle");
const { redactSensitive, redactSensitiveKeysDeep } = require("../../src/redact");
const { normalizeResult } = require("../../src/tools/result");
const { descriptors: filesystemDescriptors, buildSearchArgs } = require("../../src/tools/families/filesystem");
const { descriptors: monitoringDescriptors, resolveSnapshotPath, readSnapshotFile, writeSnapshotFile, MAX_SNAPSHOT_BYTES } = require("../../src/tools/families/monitoring");
const { readTextBounded } = require("../../src/core/bounded-file-read");
const { tunnelStopPattern, createTunnelLog } = require("../../src/tools/families/networking");
const { readJsonFile, writeJsonFile, writeTextFile } = require("../../src/core/json-file-store");
const proceduresStore = require("../../src/core/procedures-store");
const { createMcpServer, isRegistrableProcedure } = require("../../src/mcp/server");

let owner;

before(() => {
  db.runPendingMigrations();
  owner = identity.bootstrapOwner({
    username: "boundary-owner",
    password: "boundary-owner-password",
    displayName: "Boundary Owner",
  });
});

test("critical shell execution requires approval when approval settings are omitted", () => {
  const names = [
    "SIDEKICK_APPROVAL_MODE",
    "SIDEKICK_MCP_APPROVAL_MODE",
    "SIDEKICK_APPROVAL_REQUIRED_TOOLS",
    "SIDEKICK_MCP_APPROVAL_REQUIRED_TOOLS",
    "SIDEKICK_APPROVAL_EXEMPT_TOOLS",
    "SIDEKICK_MCP_APPROVAL_EXEMPT_TOOLS",
  ];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const decision = legacyTools.getApprovalDecision("bash", "mcp");
    assert.equal(decision.mode, "strict");
    assert.equal(decision.risk, "critical");
    assert.equal(decision.required, true);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

after(() => {
  try { db.closeDatabase?.(); } catch {}
  const removeOwnedEntries = root => {
    for (const entry of fs.readdirSync(root)) {
      const target = path.join(root, entry);
      if (fs.lstatSync(target).isDirectory()) removeOwnedEntries(target);
      else fs.unlinkSync(target);
    }
    fs.rmdirSync(root);
  };
  removeOwnedEntries(dataDir);
});

test("untrusted context input cannot forge a trusted source or approval capability", async () => {
  const forged = context.createExecutionContext({ source: "dashboard", approvedExecution: true });
  assert.equal(forged.source, "mcp");

  process.env.SIDEKICK_APPROVAL_MODE = "risky";
  process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = "sidekick_respond";
  const result = await dispatcher.dispatchTool({
    name: "sidekick_respond",
    args: { text: "must queue" },
    context: { source: "mcp", approvedExecution: true, bypassApproval: true },
  });
  assert.equal(result.code, "approval_required", result.content?.[0]?.text);
  process.env.SIDEKICK_APPROVAL_MODE = "off";
  process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = "";
});

test("production dispatch rejects caller descriptors and the continuation seam rejects invented authority", async () => {
  const injected = await dispatcher.dispatchTool({
    descriptor: { name: "injected", schema: { safeParse: () => ({ success: true, data: {} }) }, risk: "low", handler: () => ({ content: [] }) },
    args: {},
    context: { source: "mcp" },
  });
  assert.equal(injected.code, "descriptor_injection_denied");
  assert.equal(typeof tools.dispatcher.executeAuthorizedTaskStep, "undefined");

  const unauthorized = await dispatcher.executeAuthorizedTaskStep("sidekick_respond", { text: "no" }, {
    approvalId: "invented",
    taskId: "invented-task",
    operationId: "invented-operation",
  });
  assert.equal(unauthorized.code, "authorized_step_unauthorized");
});

test("authorization narrows credentials and delegation to current authority", () => {
  const delegate = require('../helpers/authorized-identity').createPrincipal(identity, { type: "agent", displayName: "Boundary Agent" });
  const secondOwner = require('../helpers/authorized-identity').createPrincipal(identity, { type: "human", displayName: "Second Owner" });
  identity.assignRole(secondOwner.principal_id, "owner", owner);
  const delegation = authorization.createDelegation({
    delegatorPrincipalId: owner.principal_id,
    delegatePrincipalId: delegate.principal_id,
    permissions: ["workflows.execute"],
    actorContext: owner,
  });

  assert.equal(authorization.authorize({ principalId: delegate.principal_id, permission: "workflows.execute", delegationId: delegation.delegation_id }).ok, true);
  assert.equal(authorization.authorize({ principalId: delegate.principal_id, permission: "workflows.execute", delegationId: delegation.delegation_id, credentialScopes: ["users.read"] }).code, "forbidden");

  identity.setPrincipalEnabled(owner.principal_id, false, secondOwner);
  assert.equal(authorization.authorize({ principalId: delegate.principal_id, permission: "workflows.execute", delegationId: delegation.delegation_id }).code, "delegation-revoked-or-expired");
  identity.setPrincipalEnabled(owner.principal_id, true, secondOwner);
  authorization.revokeDelegation(delegation.delegation_id, owner);
});

test("security audit records server-derived provenance without password material", () => {
  const actor = require('../helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Boundary Service" });
  securityAudit.recordSecurityEvent("boundary.checked", {
    context: context.createMcpExecutionContext({ authIdentity: { principal_id: actor.principal_id }, requestId: "boundary-request" }),
    principalId: actor.principal_id,
    details: { password: "not-persisted", decision: "deny" },
  });
  const row = db.getDb().prepare("SELECT * FROM identity_audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1").get("boundary.checked");
  assert.equal(row.principal_id, actor.principal_id);
  assert.equal(row.actor_principal_id, actor.principal_id);
  assert.doesNotMatch(row.details_json, /not-persisted/);
});

test("redaction covers nested credentials, encoded tokens, and structured result content", () => {
  const secret = ["boundary", "-secret-", "value"].join("");
  const nested = redactSensitiveKeysDeep({ config: { password: secret }, headers: { Authorization: `Bearer ${secret}` }, safe: "visible" });
  assert.equal(nested.config.password, "[REDACTED]");
  assert.doesNotMatch(nested.headers.Authorization, new RegExp(secret));
  assert.equal(nested.safe, "visible");
  assert.doesNotMatch(redactSensitive(`token=${encodeURIComponent(secret)}`), new RegExp(secret));

  const remoteInput = ["https:", "//", "deploy-user:ordinary-password@git.example.test/team/repository.git"].join("");
  const remote = redactSensitive(remoteInput);
  assert.doesNotMatch(remote, /deploy-user|ordinary-password/);
  assert.match(remote, /\[REDACTED\]@git\.example\.test\/team\/repository\.git/);
  const longSchemeRemote = `${"a".repeat(80)}://deploy-user:ordinary-password@git.example.test/team/repository.git`;
  const redactedLongSchemeRemote = redactSensitive(longSchemeRemote);
  assert.doesNotMatch(redactedLongSchemeRemote, /deploy-user|ordinary-password/);
  const schemeWithLeadingDigit = ["3https:", "//", "deploy-user:ordinary-password@git.example.test"].join("");
  assert.doesNotMatch(redactSensitive(schemeWithLeadingDigit), /deploy-user|ordinary-password/);
  assert.equal(redactSensitive("-----BEGIN PRIVATE KEY-----body-----END PRIVATE KEY-----"), "[REDACTED PRIVATE KEY]");

  const result = normalizeResult({ content: [{ type: "text", text: JSON.stringify({ api_key: secret, credentialState: "configured" }) }] });
  assert.doesNotMatch(result.content[0].text, new RegExp(secret));
  assert.match(result.content[0].text, /configured/);
});

test("redaction stays bounded on long untrusted strings that resemble URL schemes", () => {
  const redactModule = path.resolve(__dirname, "../../src/redact.js");
  const script = `const { redactSensitive } = require(${JSON.stringify(redactModule)}); const plain = "x".repeat(500000); const urls = "x://a/".repeat(100000); const jwtPrefixes = "eyJ".repeat(100000); const pemPrefixes = "-----BEGIN PRIVATE KEY-----x".repeat(30000); if (redactSensitive(plain) !== plain || redactSensitive(urls) !== urls || redactSensitive(jwtPrefixes) !== jwtPrefixes || redactSensitive(pemPrefixes) !== pemPrefixes) process.exit(2);`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || "redaction child process failed");
});

test("filesystem search patterns cannot become ripgrep or grep options", () => {
  const hostilePattern = "--pre=write-side-effect";
  for (const executable of ["/usr/bin/rg", "/usr/bin/grep"]) {
    const args = buildSearchArgs(executable, hostilePattern, "/workspace", "*.txt");
    const separator = args.indexOf("--");
    assert.ok(separator >= 0, `${executable} arguments must terminate options`);
    assert.deepEqual(args.slice(separator), ["--", hostilePattern, "/workspace"]);
  }
});

test("tunnel logs are exclusively created and stop patterns treat names literally", () => {
  const directory = fs.mkdtempSync(path.join(dataDir, "tunnel-logs-"));
  let first;
  let second;
  try {
    first = createTunnelLog(directory);
    second = createTunnelLog(directory);
    assert.notEqual(first.logPath, second.logPath);
    assert.equal(fs.existsSync(first.logPath), true);
    assert.equal(fs.existsSync(second.logPath), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(first.logPath).mode & 0o777, 0o600);
    }
    assert.equal(tunnelStopPattern("edge.v1"), "cloudflared tunnel.*--name edge\\.v1");
    assert.throws(() => tunnelStopPattern("edge.*"));
  } finally {
    for (const item of [first, second]) {
      if (!item) continue;
      try { fs.closeSync(item.fd); } catch {}
      try { fs.unlinkSync(item.logPath); } catch {}
    }
    fs.rmdirSync(directory);
  }
});

test("snapshot names cannot escape the snapshot storage directory", () => {
  const descriptor = monitoringDescriptors.find(item => item.name === "snapshot");
  assert.ok(descriptor);
  for (const name of ["../outside", "nested/name", "nested\\name", "..", "name.", "name ", "bad\nname"]) {
    assert.equal(resolveSnapshotPath(name), null, `unsafe snapshot name accepted: ${JSON.stringify(name)}`);
    assert.equal(descriptor.schema.safeParse({ action: "capture", name }).success, false);
  }
  const safePath = resolveSnapshotPath("release baseline.v1");
  assert.ok(safePath);
  assert.equal(path.dirname(safePath), path.resolve(process.env.SIDEKICK_DATA_DIR, "snapshots"));
});

test("snapshot storage reads bounded regular files and atomically replaces symlinks", async t => {
  const snapshot = { name: "safe-snapshot", date: new Date().toISOString(), types: ["processes"], data: { processes: [] } };
  writeSnapshotFile(snapshot.name, snapshot);
  assert.deepEqual(readSnapshotFile(resolveSnapshotPath(snapshot.name)), snapshot);

  const outside = path.join(dataDir, "snapshot-outside.json");
  const linkPath = resolveSnapshotPath("snapshot-link");
  fs.writeFileSync(outside, "outside data");
  try {
    fs.symlinkSync(outside, linkPath);
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }

  assert.throws(() => readSnapshotFile(linkPath));
  const replacement = { ...snapshot, name: "snapshot-link" };
  writeSnapshotFile(replacement.name, replacement);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside data");
  assert.deepEqual(readSnapshotFile(linkPath), replacement);
});

test("snapshot storage rejects oversized and malformed persisted data", () => {
  const oversizedPath = resolveSnapshotPath("oversized-snapshot");
  fs.writeFileSync(oversizedPath, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1));
  assert.throws(() => readSnapshotFile(oversizedPath), error => error.code === "FILE_READ_TOO_LARGE");

  const malformedPath = resolveSnapshotPath("malformed-snapshot");
  fs.writeFileSync(malformedPath, JSON.stringify({ name: "bad", date: "today", types: [], data: [] }));
  assert.throws(() => readSnapshotFile(malformedPath), /invalid structure/);

  assert.throws(() => writeSnapshotFile("too-large-snapshot", {
    name: "too-large-snapshot", date: "today", types: [], data: { note: "x".repeat(MAX_SNAPSHOT_BYTES) },
  }), /storage limit/);
});

test("persistent JSON stores use bounded no-follow reads and atomic replacement", () => {
  const storePath = path.join(dataDir, "persistent-state.json");
  const original = { tasks: [{ id: 1, status: "pending" }] };
  writeJsonFile(storePath, original, { maxBytes: 4096 });
  assert.deepEqual(readJsonFile(storePath, { maxBytes: 4096 }), original);

  const originalText = fs.readFileSync(storePath, "utf8");
  assert.throws(() => writeJsonFile(storePath, { text: "x".repeat(4096) }, { maxBytes: 4096 }), /byte limit/);
  assert.equal(fs.readFileSync(storePath, "utf8"), originalText, "oversized state must preserve the last committed value");

  const transcriptPath = path.join(dataDir, "bounded-transcript.json");
  writeTextFile(transcriptPath, "{\"status\":\"completed\"}", { maxBytes: 4096, mode: 0o600 });
  const transcriptText = fs.readFileSync(transcriptPath, "utf8");
  assert.equal(transcriptText, "{\"status\":\"completed\"}");
  assert.throws(() => writeTextFile(transcriptPath, "x".repeat(4097), { maxBytes: 4096 }), /byte limit/);
  assert.equal(fs.readFileSync(transcriptPath, "utf8"), transcriptText, "oversized transcript must preserve the last published value");

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error("synthetic atomic replacement failure"); };
  try {
    assert.throws(() => writeJsonFile(storePath, { tasks: [] }, { maxBytes: 4096 }), /synthetic atomic replacement failure/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(storePath, "utf8"), originalText, "failed replacement must preserve existing state");
  assert.deepEqual(fs.readdirSync(dataDir).filter(name => name.startsWith(".sidekick-json-")), []);
});

test("persistent JSON reads reject symlinks where the platform supports no-follow opens", { skip: typeof fs.constants.O_NOFOLLOW !== "number" }, () => {
  const target = path.join(dataDir, "json-outside-target.json");
  const link = path.join(dataDir, "json-state-link.json");
  fs.writeFileSync(target, JSON.stringify({ secret: "synthetic" }));
  fs.symlinkSync(target, link);
  assert.throws(() => readJsonFile(link));
});

test("learned procedures use bounded atomic persistent storage", () => {
  const procedures = { safe_example: { name: "safe_example", steps: [], parameters: {} } };
  proceduresStore.saveProcedures(procedures);
  assert.deepEqual(proceduresStore.loadProcedures(), procedures);
  if (process.platform !== "win32") assert.equal(fs.statSync(proceduresStore.PROCEDURES_FILE).mode & 0o777, 0o600);

  fs.writeFileSync(proceduresStore.PROCEDURES_FILE, Buffer.alloc(proceduresStore.MAX_PROCEDURES_BYTES + 1), { mode: 0o600 });
  assert.deepEqual(proceduresStore.loadProcedures(), {}, "oversized stored procedures are not loaded into the dynamic tool registry");
  proceduresStore.saveProcedures({});
  assert.deepEqual(proceduresStore.loadProcedures(), {});
});

test("MCP startup ignores unsafe or malformed persisted procedure definitions", () => {
  const valid = { description: "safe stored procedure", parameters: {}, steps: [{ tool: "respond", args: { text: "hello" } }] };
  assert.equal(isRegistrableProcedure("safe_persisted", valid), true);
  assert.equal(isRegistrableProcedure("toString", valid), false);
  assert.equal(isRegistrableProcedure("unsafe_parameters", { ...valid, parameters: { token: { type: "object" } } }), false);

  proceduresStore.saveProcedures({
    safe_persisted: valid,
    toString: valid,
    malformed_parameters: { ...valid, parameters: { token: { type: "object" } } },
    git: valid,
  });
  try {
    const server = createMcpServer(() => null);
    assert.equal(Object.hasOwn(server._registeredTools, "safe_persisted"), true);
    assert.equal(Object.hasOwn(server._registeredTools, "toString"), false);
    assert.equal(Object.hasOwn(server._registeredTools, "malformed_parameters"), false);
    assert.equal(Object.hasOwn(server._registeredTools, "git"), true, "the built-in registration remains intact");
  } finally {
    proceduresStore.saveProcedures({});
  }
});

test("filesystem text reads enforce byte limits and support bounded continuation", () => {
  const descriptor = filesystemDescriptors.find(item => item.name === "read");
  const file = path.join(dataDir, "bounded-read-fixture.txt");
  const text = "0123456789abcdefghijklmnopqrstuvwxyz";
  fs.writeFileSync(file, text);

  const first = readTextBounded(file, { maxBytes: 12 });
  assert.equal(first.content, text.slice(0, 12));
  assert.equal(first.truncated, true);
  const second = readTextBounded(file, { maxBytes: 12, offset: first.bytesRead });
  assert.equal(second.content, text.slice(12, 24));
  assert.equal(second.truncated, true);
  assert.throws(() => readTextBounded(file, { maxBytes: 12, requireComplete: true }), error => error.code === "FILE_READ_TOO_LARGE");
  assert.throws(() => readTextBounded(dataDir, { maxBytes: 12 }), error => error.code === "FILE_READ_NOT_REGULAR");
  assert.equal(descriptor.schema.safeParse({ path: file, offset: 0 }).success, true);
  assert.equal(descriptor.schema.safeParse({ path: file, offset: -1 }).success, false);
});

test("workflow definitions reject forward references, executable syntax, and duplicate steps", () => {
  const base = { name: "boundary/workflow", version: "1.0.0", title: "Boundary", description: "Boundary test", steps: [{ name: "first", tool: "respond", args: {} }] };
  assert.throws(() => normalizeDefinition({ ...base, steps: [{ name: "first", tool: "respond", args: { value: "${steps.second.text}" } }, { name: "second", tool: "respond" }] }), /before it runs/);
  assert.throws(() => normalizeDefinition({ ...base, steps: [{ name: "first", tool: "../shell", args: {} }] }), /Invalid workflow definition/);
  assert.throws(() => normalizeDefinition({ ...base, steps: [{ name: "first", tool: "respond" }, { name: "first", tool: "respond" }] }), /duplicate step name/);
});

test("pack validation refuses symlinked manifests without reading outside content", () => {
  const outside = path.join(dataDir, "outside-manifest.json");
  const pack = path.join(dataDir, "hostile-pack");
  fs.mkdirSync(pack);
  fs.writeFileSync(outside, JSON.stringify({ name: "outside-secret", password: "never-read" }));
  fs.symlinkSync(outside, path.join(pack, "sidekick.pack.json"));
  const report = packLifecycle.validate(pack);
  assert.equal(report.valid, false);
  assert.ok(report.findings.some(finding => /symlink/.test(finding.problem)));
  assert.doesNotMatch(JSON.stringify(report), /never-read/);
});
