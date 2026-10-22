"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createScheduledAuthority, verifyScheduledAuthority } = require("../src/security/scheduled-authority");
const { createDelayExecution } = require("../src/agent/delay-execution");

const secret = "synthetic-scheduled-authority-key-32-bytes";
process.env.NODE_ENV = "test";
process.env.SIDEKICK_SECRET_KEY = secret;

function fixture() {
  const delay = {
    id: "delay_test_1",
    platform_execution_id: "exec_test_1",
    when: "2030-01-01T00:00:00.000Z",
    tool: "git",
    args: { action: "status", path: "workspace:project/repo" },
    status: "pending",
  };
  const context = {
    project: "project-a",
    taskId: "task-a",
    source: "agent",
    authIdentity: {
      principal_id: "principal-a",
      principal_type: "human",
      scopes: ["tools.execute", "tools.execute_high"],
      credential_id: "cred_a",
      delegation_id: "delegation-a",
      authentication_method: "scoped_credential",
    },
    agentAuthorityContext: {
      envelope: { version: 1, allowed_effects: ["read_only"], changes_allowed: false },
      principal_ref: "principal-a",
      project_ref: "project-a",
      workspace_ref: "workspace:project-a/repo",
      repository_ref: "repository:project-a/repo",
    },
  };
  return { delay, context };
}

test("signed scheduled authority restores authenticated and Agent-scoped context", () => {
  const { delay, context } = fixture();
  delay.scheduled_authority = createScheduledAuthority({ delay, context, secret });
  const restored = verifyScheduledAuthority({ delay, secret });
  assert.equal(restored.authIdentity.principal_id, "principal-a");
  assert.deepEqual(restored.authIdentity.scopes, ["tools.execute", "tools.execute_high"]);
  assert.equal(restored.authIdentity.credential_id, "cred_a");
  assert.equal(restored.agentAuthorityContext.principal_ref, "principal-a");
  assert.equal(restored.project, "project-a");
  assert.equal(restored.taskId, "task-a");
});

test("delay arguments, target, time, and execution binding cannot change after signing", () => {
  for (const mutate of [
    delay => { delay.args.action = "push"; },
    delay => { delay.tool = "bash"; },
    delay => { delay.when = "2029-01-01T00:00:00.000Z"; },
    delay => { delay.platform_execution_id = "exec_other"; },
    delay => { delay.id = "delay_other"; },
  ]) {
    const { delay, context } = fixture();
    delay.scheduled_authority = createScheduledAuthority({ delay, context, secret });
    mutate(delay);
    assert.equal(verifyScheduledAuthority({ delay, secret }), null);
  }
});

test("stored signature tampering and key rotation fail closed", () => {
  const { delay, context } = fixture();
  delay.scheduled_authority = createScheduledAuthority({ delay, context, secret });
  delay.scheduled_authority.signature = "0".repeat(64);
  assert.equal(verifyScheduledAuthority({ delay, secret }), null);
  delay.scheduled_authority = createScheduledAuthority({ delay, context, secret });
  assert.equal(verifyScheduledAuthority({ delay, secret: "different-synthetic-key-32-bytes-long" }), null);
});

test("due-time dispatch restores current principal context and intersects current credential scopes", async () => {
  const { delay, context } = fixture();
  delay.scheduled_authority = createScheduledAuthority({ delay, context, secret });
  const delays = [delay];
  let dispatched = null;
  const execute = createDelayExecution({
    loadDelays: () => delays,
    saveDelays: () => {},
    callAgentTool: async (_tool, _args, options) => { dispatched = options; return { isError: false, content: [{ text: "ok" }] }; },
    claimExecution: () => ({ ok: true, claim: { claimed_by: "test", claim_epoch: 1 } }),
    releaseScheduledClaim: () => ({ ok: true }),
    startScheduledLeaseRenewal: () => null,
    transitionScheduledPlatformExecution: () => {},
    appendScheduledPlatformEvent: () => {},
    authorizeScheduledDelay: () => ({ ok: true }),
    getCredential: () => ({ credential_id: "cred_a", principal_id: "principal-a", scopes: ["tools.execute"], revoked_at: null, expires_at: null }),
    getPrincipal: () => ({ enabled: true }),
    getDelayTimers: () => ({}),
    processId: 1,
  });

  await execute(delay);
  assert.equal(dispatched.authIdentity.principal_id, "principal-a");
  assert.deepEqual(dispatched.authIdentity.scopes, ["tools.execute"], "a later credential scope reduction must attenuate the scheduled request");
  assert.equal(dispatched.agentAuthorityContext.principal_ref, "principal-a");
  assert.equal(delay.status, "completed");
});

test("due-time dispatch refuses a revoked credential and does not call the tool", async () => {
  const { delay, context } = fixture();
  delay.scheduled_authority = createScheduledAuthority({ delay, context, secret });
  const delays = [delay];
  let called = false;
  const execute = createDelayExecution({
    loadDelays: () => delays,
    saveDelays: () => {},
    callAgentTool: async () => { called = true; return { isError: false, content: [{ text: "unexpected" }] }; },
    claimExecution: () => ({ ok: true, claim: { claimed_by: "test", claim_epoch: 1 } }),
    releaseScheduledClaim: () => ({ ok: true }),
    startScheduledLeaseRenewal: () => null,
    transitionScheduledPlatformExecution: () => {},
    appendScheduledPlatformEvent: () => {},
    getCredential: () => ({ credential_id: "cred_a", principal_id: "principal-a", scopes: [], revoked_at: "2026-10-19T00:00:00.000Z", expires_at: null }),
    getPrincipal: () => ({ enabled: true }),
    getDelayTimers: () => ({}),
    processId: 1,
  });

  await execute(delay);
  assert.equal(called, false);
  assert.equal(delay.status, "failed");
  assert.match(delay.error, /authority could not be verified/);
});

test("due-time dispatch refuses a disabled principal", async () => {
  const { delay, context } = fixture();
  delay.scheduled_authority = createScheduledAuthority({ delay, context, secret });
  const delays = [delay];
  let called = false;
  const execute = createDelayExecution({
    loadDelays: () => delays, saveDelays: () => {},
    callAgentTool: async () => { called = true; return { isError: false, content: [{ text: "unexpected" }] }; },
    claimExecution: () => ({ ok: true, claim: { claimed_by: "test", claim_epoch: 1 } }),
    releaseScheduledClaim: () => ({ ok: true }), startScheduledLeaseRenewal: () => null,
    transitionScheduledPlatformExecution: () => {}, appendScheduledPlatformEvent: () => {},
    getCredential: () => ({ credential_id: "cred_a", principal_id: "principal-a", scopes: ["tools.execute"], revoked_at: null, expires_at: null }),
    getPrincipal: () => ({ enabled: false }), getDelayTimers: () => ({}), processId: 1,
  });

  await execute(delay);
  assert.equal(called, false);
  assert.equal(delay.status, "failed");
});

test("due-time dispatch refuses a now-disallowed Agent authority envelope", async () => {
  const { delay, context } = fixture();
  delay.scheduled_authority = createScheduledAuthority({ delay, context, secret });
  const delays = [delay];
  let called = false;
  const execute = createDelayExecution({
    loadDelays: () => delays, saveDelays: () => {},
    callAgentTool: async () => { called = true; return { isError: false, content: [{ text: "unexpected" }] }; },
    claimExecution: () => ({ ok: true, claim: { claimed_by: "test", claim_epoch: 1 } }),
    releaseScheduledClaim: () => ({ ok: true }), startScheduledLeaseRenewal: () => null,
    transitionScheduledPlatformExecution: () => {}, appendScheduledPlatformEvent: () => {},
    authorizeScheduledDelay: () => ({ ok: false }),
    getCredential: () => ({ credential_id: "cred_a", principal_id: "principal-a", scopes: ["tools.execute"], revoked_at: null, expires_at: null }),
    getPrincipal: () => ({ enabled: true }), getDelayTimers: () => ({}), processId: 1,
  });

  await execute(delay);
  assert.equal(called, false);
  assert.equal(delay.status, "failed");
});

test("scheduled creation and Agent recovery wire the signed record into the governed dispatch", () => {
  const scheduling = fs.readFileSync(require.resolve("../src/tools/families/scheduling"), "utf8");
  const executor = fs.readFileSync(require.resolve("../src/agent/delay-execution"), "utf8");
  const policy = fs.readFileSync(require.resolve("../src/agent/delay-policy"), "utf8");
  const agent = fs.readFileSync(require.resolve("../src/agent"), "utf8");
  assert.match(scheduling, /createScheduledAuthority\(/);
  assert.match(scheduling, /verifyScheduledAuthority\(/);
  assert.match(executor, /restoreScheduledContext\(/);
  assert.match(policy, /getCredential\(stored\.credential_id\)/);
  assert.match(policy, /credential\.revoked_at/);
  assert.match(executor, /const result = await callAgentTool\([\s\S]*?authIdentity: scheduledContext\.authIdentity/);
  assert.match(agent, /authorizeScheduledDelay:[\s\S]*?authorizeScheduledAgentDelay\(/);
  assert.match(scheduling, /restoreScheduledContext\(verifiedAuthority\)/);
  assert.match(scheduling, /authorizeScheduledAgentDelay\(delay, scheduledContext/);
});
