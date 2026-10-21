"use strict";

/** Reconstruct durable authority only from role state or a currently valid credential. */
function persistedTaskAuthIdentity(task, { getCredential } = {}) {
  const principalId = task && (task.actor_principal_id || task.requested_by_principal_id);
  const context = task && task.principal_context;
  if (!principalId || !context || context.version !== 1) return null;

  const credentialId = context.credential_id || null;
  const snapshot = context.credential_scopes;
  if (snapshot === null) {
    if (credentialId) return null;
    return { principal_id: principalId, scopes: null, delegation_id: context.delegation_id || null, authentication_method: "durable-task-context" };
  }
  // Explicit scopes are credential authority, never a self-authenticating
  // permission snapshot. Missing/malformed legacy provenance fails closed.
  if (!Array.isArray(snapshot) || !credentialId) return null;
  let credential;
  try {
    const lookup = getCredential || require("../core/authentication").getCredential;
    credential = lookup(credentialId);
  } catch { return null; }
  if (!credential || credential.credential_id !== credentialId || credential.principal_id !== principalId || credential.revoked_at) return null;
  if (credential.expires_at && (!Number.isFinite(Date.parse(credential.expires_at)) || Date.parse(credential.expires_at) <= Date.now())) return null;
  if (!Array.isArray(credential.scopes)) return null;
  const current = new Set(credential.scopes.map(String));
  const scopes = [...new Set(snapshot.map(String))].filter(scope => current.has("*") || current.has(scope));
  return { principal_id: principalId, scopes, credential_id: credentialId, delegation_id: context.delegation_id || null, authentication_method: "durable-task-credential" };
}

module.exports = { persistedTaskAuthIdentity };
