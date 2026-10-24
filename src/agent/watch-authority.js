"use strict";

const authentication = require("../core/authentication");
const identity = require("../core/identity");
const authorization = require("../core/authorization");
const { requiredToolPermission } = require("../tools/dispatcher");
const { verifyScheduledWatchAuthority } = require("../security/scheduled-authority");
const { restoreScheduledContext, authorizeScheduledAgentDelay } = require("./delay-policy");

/** Verify a persisted watch and rebuild only authority that remains current. */
function authorizeScheduledWatch(watch, {
  secret,
  getCredential = authentication.getCredential,
  getPrincipal = identity.getPrincipal,
  getDescriptor,
  authorize = authorization.authorize,
  permissionFor = requiredToolPermission,
  authorizeAgentContext = authorizeScheduledAgentDelay,
} = {}) {
  const signedContext = verifyScheduledWatchAuthority({ watch, secret });
  if (!signedContext) return { ok: false, reason: "scheduled_authority_invalid" };
  const context = restoreScheduledContext(signedContext, { getCredential, getPrincipal });
  if (!context?.authIdentity?.principal_id) return { ok: false, reason: "scheduled_identity_invalid" };
  if (typeof getDescriptor !== "function") return { ok: false, reason: "live_tool_catalog_unavailable" };
  const descriptor = getDescriptor(watch.action_tool);
  if (!descriptor) return { ok: false, reason: "scheduled_action_unavailable" };
  const permission = permissionFor(descriptor, watch.action_args || {});
  const grant = authorize({
    principalId: context.authIdentity.principal_id,
    permission,
    credentialScopes: context.authIdentity.scopes,
    delegationId: context.authIdentity.delegation_id || context.authIdentity.delegationId || null,
    resource: { tool: descriptor.name, source: "agent" },
  });
  if (!grant?.ok) return { ok: false, reason: grant?.code || "authorization_denied" };
  const authority = authorizeAgentContext(
    { tool: descriptor.name, args: watch.action_args || {} },
    context,
    { getDescriptor },
  );
  if (!authority?.ok) return { ...authority, ok: false, context };
  return { ...authority, ok: true, context };
}

module.exports = Object.freeze({ authorizeScheduledWatch });
