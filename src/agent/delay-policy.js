"use strict";

const authentication = require("../core/authentication");
const identity = require("../core/identity");
const { decideAutonomy } = require("./authority");

/** Restore a signed schedule identity only while its current authority remains valid. */
function restoreScheduledContext(context, {
  getCredential = authentication.getCredential,
  getPrincipal = identity.getPrincipal,
} = {}) {
  if (!context || typeof context !== "object") return null;
  const stored = context.authIdentity;
  if (!stored?.principal_id) return null;

  const principal = getPrincipal(stored.principal_id);
  if (!principal?.enabled) return null;

  let authIdentity = { ...stored };
  if (stored.credential_id) {
    const credential = getCredential(stored.credential_id);
    if (!credential || credential.credential_id !== stored.credential_id || credential.principal_id !== stored.principal_id || credential.revoked_at) return null;
    if (credential.expires_at && (!Number.isFinite(Date.parse(credential.expires_at)) || Date.parse(credential.expires_at) <= Date.now())) return null;
    if (!Array.isArray(credential.scopes)) return null;
    const storedScopes = Array.isArray(stored.scopes) ? stored.scopes : [];
    const currentScopes = new Set(credential.scopes.map(String));
    authIdentity = { ...stored, scopes: [...new Set(storedScopes.map(String))].filter(scope => currentScopes.has("*") || currentScopes.has(scope)) };
  } else if (stored.scopes !== null) {
    // Scoped credentials must have a credential ID so their current scopes can
    // be revalidated. A signed scope snapshot alone is not current authority.
    return null;
  }

  return { ...context, authIdentity };
}

/** Recheck the signed Agent envelope against the current live tool descriptor. */
function authorizeScheduledAgentDelay(delay, context, { getDescriptor } = {}) {
  const authorityContext = context?.agentAuthorityContext;
  if (!authorityContext) return { ok: true };
  if (typeof getDescriptor !== "function") return { ok: false, reason: "live Agent capability catalog is unavailable" };

  const descriptor = getDescriptor(delay?.tool);
  const decision = decideAutonomy({
    descriptor,
    args: delay?.args || {},
    envelope: authorityContext.envelope,
    principalRef: authorityContext.principal_ref,
    projectRef: context.project || authorityContext.project_ref,
    workspaceRef: authorityContext.workspace_ref,
    repositoryRef: authorityContext.repository_ref,
    capabilityRef: delay?.tool,
    descriptorVersion: descriptor?.version,
  });
  return {
    ok: decision.decision !== "deny",
    authorityApprovalRequired: decision.approval_required,
    authorityRisk: decision.risk_class,
    authorityReason: decision.reason,
  };
}

module.exports = Object.freeze({ restoreScheduledContext, authorizeScheduledAgentDelay });
