"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-scheduled-delay-dispatch-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_SECRET_KEY = "synthetic-scheduled-dispatch-secret-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_AGENT_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");
const { callAgentTool } = require("../src/tools");
const { createScheduledAuthority } = require("../src/security/scheduled-authority");
const { createDelayExecution } = require("../src/agent/delay-execution");

const owner = identity.bootstrapOwner({ username: "schedule-owner", password: "correct horse battery staple", displayName: "Schedule Owner" });
const ownerContext = { principal_id: owner.principal_id };
const machineCredential = authentication.createCredential({
  principalId: owner.principal_id,
  displayName: "Scoped scheduled executor",
  scopes: ["tools.execute"],
  createdByPrincipalId: owner.principal_id,
  actorContext: ownerContext,
});
const initialIdentity = authentication.authenticateCredential(machineCredential.token);

function signedDelay(id) {
  const delay = {
    id,
    platform_execution_id: `exec_${id}`,
    when: new Date(Date.now() + 60_000).toISOString(),
    tool: "respond",
    args: { text: `scheduled-${id}` },
    status: "pending",
  };
  delay.scheduled_authority = createScheduledAuthority({
    delay,
    context: { authIdentity: initialIdentity, project: "scheduled-project", taskId: id, source: "agent" },
    secret: process.env.SIDEKICK_SECRET_KEY,
  });
  return delay;
}

function runner(delay, calls) {
  const delays = [delay];
  const execute = createDelayExecution({
    loadDelays: () => delays,
    saveDelays: () => {},
    callAgentTool: async (tool, args, options) => {
      calls.push({ tool, args, options });
      return callAgentTool(tool, args, options);
    },
    claimExecution: () => ({ ok: true, claim: { claimed_by: "test-agent", claim_epoch: 1 } }),
    releaseScheduledClaim: () => ({ ok: true }),
    startScheduledLeaseRenewal: () => null,
    transitionScheduledPlatformExecution: () => {},
    appendScheduledPlatformEvent: () => {},
    getDelayTimers: () => ({}),
    processId: process.pid,
  });
  return { execute, delay };
}

test("a signed due-time delay executes through the real dispatcher with the original scoped principal", async () => {
  const calls = [];
  const { execute, delay } = runner(signedDelay("delay-live-authorized"), calls);
  await execute(delay);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.authIdentity.principal_id, owner.principal_id);
  assert.equal(calls[0].options.authIdentity.credential_id, machineCredential.credential.credential_id);
  assert.deepEqual(calls[0].options.authIdentity.scopes, ["tools.execute"]);
  assert.equal(delay.status, "completed");
});

test("the real dispatcher denies a scheduled effect after its credential scope is reduced", async () => {
  const calls = [];
  const { execute, delay } = runner(signedDelay("delay-live-revoked-scope"), calls);
  db.getDb().prepare("UPDATE identity_credentials SET scopes_json = '[]' WHERE credential_id = ?").run(machineCredential.credential.credential_id);
  await execute(delay);
  assert.equal(calls.length, 1, "dispatcher is reached with the intersected empty scope, not skipped by the scheduler");
  assert.equal(calls[0].options.authIdentity.scopes.length, 0);
  assert.equal(calls[0].options.authIdentity.scopes.includes("tools.execute"), false);
  assert.equal(delay.status, "failed");
  assert.match(delay.result, /^Authorization denied: forbidden \(required permission: tools\.execute\)$/);
});

test("the real dispatcher denies a scheduled effect after its delegation is revoked", async () => {
  const delegate = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Scheduled delegate" });
  const delegation = authorization.createDelegation({
    delegatorPrincipalId: owner.principal_id,
    delegatePrincipalId: delegate.principal_id,
    permissions: ["tools.execute"],
    actorContext: owner,
  });
  const credential = authentication.createCredential({
    principalId: delegate.principal_id,
    displayName: "Delegated scheduled executor",
    scopes: ["tools.execute"],
    createdByPrincipalId: owner.principal_id,
    actorContext: ownerContext,
  });
  const delegatedIdentity = {
    ...authentication.authenticateCredential(credential.token),
    delegation_id: delegation.delegation_id,
  };
  const delay = signedDelay("delay-revoked-delegation");
  delay.scheduled_authority = createScheduledAuthority({
    delay,
    context: { authIdentity: delegatedIdentity, project: "scheduled-project", taskId: delay.id, source: "agent" },
    secret: process.env.SIDEKICK_SECRET_KEY,
  });
  authorization.revokeDelegation(delegation.delegation_id, owner);

  const calls = [];
  const { execute } = runner(delay, calls);
  await execute(delay);
  assert.equal(calls.length, 1, "execution reaches the canonical dispatcher with the signed delegation identity");
  assert.equal(calls[0].options.authIdentity.delegation_id, delegation.delegation_id);
  assert.equal(delay.status, "failed");
  assert.match(delay.result, /delegation-revoked-or-expired/);
});

test.after(() => {
  try { db.closeDatabase(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});
