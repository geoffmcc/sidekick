"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-approved-scope-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "strict";
process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = "secret";
process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = "";
process.env.SIDEKICK_SECRET_KEY = "synthetic-approved-scope-test-key";
delete process.env.SIDEKICK_SECRET_DIR;

const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const tools = require("../src/tools");
const legacyTools = require("../src/tools-legacy");

test("standalone approved dispatch keeps the reviewer's credential scope at canonical authorization", async t => {
  t.after(() => {
    dbStore.getDb().close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const owner = identity.bootstrapOwner({
    username: "scope_reviewer",
    password: "synthetic scope reviewer test password",
  });

  const queued = await tools.callDashboardTool("secret", { action: "list" }, {
    authIdentity: {
      principal_id: owner.principal_id,
      principal_type: "human",
      scopes: ["secrets.read_metadata"],
    },
  });
  assert.equal(queued.code, "approval_required");
  assert.ok(queued.approvalId);

  const scopeLimitedReviewer = identity.createPrincipal({ type: "service", displayName: "Scope-limited approval reviewer", actorIdentity: owner });
  identity.grantPrincipalPermission(scopeLimitedReviewer.principal_id, "approvals.grant", owner);
  const scopeLimitedCredential = authentication.createCredential({
    principalId: scopeLimitedReviewer.principal_id,
    displayName: "Scope-limited approval credential",
    scopes: ["approvals.grant"],
    createdByPrincipalId: owner.principal_id,
    actorContext: owner,
  });

  const approved = await tools.resolveApproval(queued.approvalId, "approve", scopeLimitedReviewer.principal_id, {
    reviewerPrincipalId: scopeLimitedReviewer.principal_id,
    reviewerAuthIdentity: authentication.authenticateBearerIdentity(scopeLimitedCredential.token),
  });
  assert.equal(approved.isError, true);
  assert.equal(approved.code, "authorization_denied");
  assert.match(approved.content?.[0]?.text || "", /Authorization denied/);

  const selfQueued = await tools.callDashboardTool("secret", { action: "list" }, {
    authIdentity: {
      principal_id: owner.principal_id,
      principal_type: "human",
      scopes: ["secrets.read_metadata", "approvals.grant"],
    },
  });
  assert.equal(selfQueued.code, "approval_required");
  const selfApproved = await tools.resolveApproval(selfQueued.approvalId, "approve", owner.principal_id, {
    reviewerPrincipalId: owner.principal_id,
    reviewerAuthIdentity: {
      principal_id: owner.principal_id,
      principal_type: "human",
      scopes: ["secrets.read_metadata", "approvals.grant"],
    },
  });
  assert.equal(selfApproved.isError, true, "the same principal cannot approve a standalone request it initiated");
  assert.equal(selfApproved.code, "self_approval_denied");
  assert.equal(tools.listApprovals({ status: "pending" }).find(item => item.id === selfQueued.approvalId)?.status, "pending", "a denied self-approval leaves the request pending for independent review");

  const independentReviewer = identity.createPrincipal({ type: "service", displayName: "Independent approval reviewer", actorIdentity: owner });
  identity.grantPrincipalPermission(independentReviewer.principal_id, "approvals.grant", owner);
  identity.grantPrincipalPermission(independentReviewer.principal_id, "secrets.read_metadata", owner);
  const independentToken = authentication.createCredential({
    principalId: independentReviewer.principal_id,
    displayName: "Independent approval credential",
    scopes: ["approvals.grant", "secrets.read_metadata"],
    createdByPrincipalId: owner.principal_id,
    actorContext: owner,
  });
  const approvedByIndependent = await tools.resolveApproval(selfQueued.approvalId, "approve", independentReviewer.principal_id, {
    reviewerPrincipalId: independentReviewer.principal_id,
    reviewerAuthIdentity: authentication.authenticateBearerIdentity(independentToken.token),
  });
  assert.notEqual(approvedByIndependent.isError, true, approvedByIndependent.content?.[0]?.text);

  const unboundLegacyApproval = legacyTools.queueApproval("secret", { action: "list" }, {
    risk: "high",
    source: "mcp",
    mode: "strict",
    reason: "legacy request missing an authenticated principal",
  });
  const unboundResult = await tools.resolveApproval(unboundLegacyApproval.id, "approve", independentReviewer.principal_id, {
    reviewerPrincipalId: independentReviewer.principal_id,
    reviewerAuthIdentity: authentication.authenticateBearerIdentity(independentToken.token),
  });
  assert.equal(unboundResult.isError, true);
  assert.equal(unboundResult.code, "approval_requester_unbound");
  assert.equal(tools.listApprovals({ status: "pending" }).find(item => item.id === unboundLegacyApproval.id)?.status, "pending");
});
