"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

let owner;

before(() => {
  db.runPendingMigrations();
  owner = identity.bootstrapOwner({
    username: "boundary-owner",
    password: "boundary-owner-password",
    displayName: "Boundary Owner",
  });
});

after(() => {
  try { db.close(); } catch {}
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
  const delegate = identity.createPrincipal({ type: "agent", displayName: "Boundary Agent" });
  const secondOwner = identity.createPrincipal({ type: "human", displayName: "Second Owner" });
  identity.assignRole(secondOwner.principal_id, "owner", owner.principal_id);
  const delegation = authorization.createDelegation({
    delegatorPrincipalId: owner.principal_id,
    delegatePrincipalId: delegate.principal_id,
    permissions: ["workflows.execute"],
    actorPrincipalId: owner.principal_id,
  });

  assert.equal(authorization.authorize({ principalId: delegate.principal_id, permission: "workflows.execute", delegationId: delegation.delegation_id }).ok, true);
  assert.equal(authorization.authorize({ principalId: delegate.principal_id, permission: "workflows.execute", delegationId: delegation.delegation_id, credentialScopes: ["users.read"] }).code, "forbidden");

  identity.setPrincipalEnabled(owner.principal_id, false, secondOwner.principal_id);
  assert.equal(authorization.authorize({ principalId: delegate.principal_id, permission: "workflows.execute", delegationId: delegation.delegation_id }).code, "delegation-revoked-or-expired");
  identity.setPrincipalEnabled(owner.principal_id, true, secondOwner.principal_id);
  authorization.revokeDelegation(delegation.delegation_id, owner.principal_id);
});

test("security audit records server-derived provenance without password material", () => {
  const actor = identity.createPrincipal({ type: "service", displayName: "Boundary Service" });
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

  const result = normalizeResult({ content: [{ type: "text", text: JSON.stringify({ api_key: secret, credentialState: "configured" }) }] });
  assert.doesNotMatch(result.content[0].text, new RegExp(secret));
  assert.match(result.content[0].text, /configured/);
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
