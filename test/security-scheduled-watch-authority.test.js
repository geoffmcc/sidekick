"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createScheduledWatchAuthority } = require("../src/security/scheduled-authority");
const { authorizeScheduledWatch } = require("../src/agent/watch-authority");

const secret = "synthetic-scheduled-watch-authority-secret";

function fixture() {
  const watch = {
    id: "watch_authority_1", platform_execution_id: "exec_watch_authority_1",
    source: "file", target: "workspace:project-a/repo/ready", condition: "exists",
    value: null, interval: "60s", action_tool: "notify", action_args: { message: "ready" },
    status: "active",
  };
  const context = {
    project: "project-a", taskId: "task-a", source: "mcp",
    authIdentity: {
      principal_id: "principal-a", principal_type: "human", credential_id: "credential-a",
      scopes: ["comms.notify"], delegation_id: null, authentication_method: "scoped_credential",
    },
    agentAuthorityContext: null,
  };
  watch.scheduled_authority = createScheduledWatchAuthority({ watch, context, secret });
  return { watch };
}

function dependencies(overrides = {}) {
  return {
    secret,
    getCredential: () => ({
      credential_id: "credential-a", principal_id: "principal-a", scopes: ["comms.notify"],
      revoked_at: null, expires_at: null,
    }),
    getPrincipal: () => ({ enabled: true }),
    getDescriptor: () => ({ name: "notify", authorizationPermission: "comms.notify", version: "1" }),
    authorize: ({ credentialScopes }) => ({ ok: credentialScopes?.includes("comms.notify") === true, code: "permission_denied" }),
    authorizeAgentContext: () => ({ ok: true }),
    ...overrides,
  };
}

test("scheduled watch rebuilds current identity and narrows it to current credential scopes", () => {
  const { watch } = fixture();
  let dispatchedContext = null;
  const result = authorizeScheduledWatch(watch, dependencies({
    getCredential: () => ({ credential_id: "credential-a", principal_id: "principal-a", scopes: ["comms.notify", "tools.execute"], revoked_at: null, expires_at: null }),
    authorize: ({ credentialScopes }) => { dispatchedContext = credentialScopes; return { ok: true }; },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.context.authIdentity.principal_id, "principal-a");
  assert.deepEqual(dispatchedContext, ["comms.notify"]);
});

test("scheduled watch fails closed for revoked credentials and disabled principals", () => {
  const { watch } = fixture();
  const revoked = authorizeScheduledWatch(watch, dependencies({
    getCredential: () => ({ credential_id: "credential-a", principal_id: "principal-a", scopes: ["comms.notify"], revoked_at: "2030-01-01T00:00:00.000Z", expires_at: null }),
  }));
  assert.equal(revoked.ok, false);

  const disabled = authorizeScheduledWatch(watch, dependencies({ getPrincipal: () => ({ enabled: false }) }));
  assert.equal(disabled.ok, false);
});

test("scheduled watch rechecks current permission and Agent authority", () => {
  const { watch } = fixture();
  const revokedGrant = authorizeScheduledWatch(watch, dependencies({ authorize: () => ({ ok: false, code: "grant_revoked" }) }));
  assert.equal(revokedGrant.ok, false);
  assert.equal(revokedGrant.reason, "grant_revoked");

  const restrictedEnvelope = authorizeScheduledWatch(watch, dependencies({ authorizeAgentContext: () => ({ ok: false, reason: "effect_no_longer_allowed" }) }));
  assert.equal(restrictedEnvelope.ok, false);
  assert.equal(restrictedEnvelope.reason, "effect_no_longer_allowed");
});

test("modified scheduled watch definition is rejected before any authority is restored", () => {
  const { watch } = fixture();
  watch.action_args.message = "changed action";
  let principalLookups = 0;
  const result = authorizeScheduledWatch(watch, dependencies({ getPrincipal: () => { principalLookups += 1; return { enabled: true }; } }));
  assert.equal(result.ok, false);
  assert.equal(principalLookups, 0);
});
