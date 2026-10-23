"use strict";

const authentication = require("../core/authentication");
const authorization = require("../core/authorization");
const identity = require("../core/identity");

const MAX_SCOPES = 128;

/** Capture a bounded, non-secret authority snapshot for a durable direct job. */
function captureExecutionAuthority(authIdentity, permission) {
  if (!authIdentity?.principal_id) return null;
  if (typeof authIdentity.principal_id !== "string" || authIdentity.principal_id.length > 160) {
    throw new Error("direct job principal identity is invalid");
  }
  if (typeof permission !== "string" || !authorization.knownPermission(permission)) {
    throw new Error("direct job authorization permission is invalid");
  }
  const credentialScopes = authIdentity.scopes === undefined ? null : authIdentity.scopes;
  if (credentialScopes !== null && (!Array.isArray(credentialScopes) || credentialScopes.length > MAX_SCOPES || credentialScopes.some(scope => typeof scope !== "string" || !scope.trim() || scope.length > 160))) {
    throw new Error("direct job credential scopes are invalid");
  }
  const credentialId = authIdentity.credential_id || null;
  if (credentialId !== null && (typeof credentialId !== "string" || credentialId.length > 160)) {
    throw new Error("direct job credential reference is invalid");
  }
  const delegationId = authIdentity.delegation_id || authIdentity.delegationId || null;
  if (delegationId !== null && (typeof delegationId !== "string" || delegationId.length > 160)) {
    throw new Error("direct job delegation reference is invalid");
  }
  if (credentialScopes !== null && !credentialId) {
    throw new Error("scoped direct job authority requires its credential reference");
  }
  return {
    version: 1,
    principal_id: authIdentity.principal_id,
    permission,
    credential_scopes: credentialScopes === null ? null : [...new Set(credentialScopes.map(scope => scope.trim()))],
    ...(credentialId ? { credential_id: credentialId } : {}),
    delegation_id: delegationId,
  };
}

/** Restore only authority that remains valid now; a stored snapshot is never a grant. */
function restoreExecutionAuthority(snapshot, {
  getCredential = authentication.getCredential,
  getPrincipal = identity.getPrincipal,
} = {}) {
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.principal_id !== "string" || !snapshot.principal_id || typeof snapshot.permission !== "string" || !snapshot.permission) return null;
  if (snapshot.principal_id.length > 160 || (snapshot.credential_id != null && (typeof snapshot.credential_id !== "string" || !snapshot.credential_id || snapshot.credential_id.length > 160)) || (snapshot.delegation_id != null && (typeof snapshot.delegation_id !== "string" || snapshot.delegation_id.length > 160))) return null;
  const principal = getPrincipal(snapshot.principal_id);
  if (!principal?.enabled) return null;

  let scopes = snapshot.credential_scopes;
  if (scopes !== null) {
    if (!Array.isArray(scopes) || scopes.length > MAX_SCOPES || scopes.some(scope => typeof scope !== "string" || !scope.trim() || scope.length > 160) || !snapshot.credential_id) return null;
    const credential = getCredential(snapshot.credential_id);
    if (!credential || credential.credential_id !== snapshot.credential_id || credential.principal_id !== snapshot.principal_id || credential.revoked_at) return null;
    if (credential.expires_at && (!Number.isFinite(Date.parse(credential.expires_at)) || Date.parse(credential.expires_at) <= Date.now())) return null;
    if (!Array.isArray(credential.scopes)) return null;
    const current = new Set(credential.scopes.map(String));
    scopes = [...new Set(scopes.map(String))].filter(scope => current.has("*") || current.has(scope));
  } else if (snapshot.credential_id) {
    return null;
  }

  const authIdentity = {
    principal_id: snapshot.principal_id,
    scopes,
    delegation_id: snapshot.delegation_id || null,
    ...(snapshot.credential_id ? { credential_id: snapshot.credential_id } : {}),
    authentication_method: "durable-compute-job",
  };
  const decision = authorization.authorize({
    principalId: authIdentity.principal_id,
    permission: snapshot.permission,
    credentialScopes: authIdentity.scopes,
    delegationId: authIdentity.delegation_id,
    resource: { kind: "compute_direct_job" },
  });
  return decision.ok ? authIdentity : null;
}

module.exports = Object.freeze({ captureExecutionAuthority, restoreExecutionAuthority });
