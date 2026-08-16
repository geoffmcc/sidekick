"use strict";

// Connector resolution — the single place that turns a registered connector's
// stored `secret_ref` into a usable credential and exposes the connector's
// governed endpoint. Mirrors src/compute/provider-credentials.js: resolution is
// as late as possible (at call time), reuses Sidekick's existing encrypted
// secret store, and never logs secret material or surfaces the reference/value
// on a connector record (callers see only `has_secret_ref`).
//
// A connector's `secret_ref` is an opaque `secret:<name>` reference validated by
// the platform kernel; `<name>` is a key in the encrypted secret store (the same
// store the `secret` tool manages).

const { loadSecrets } = require("../core/secrets-store");
const { decryptSecret } = require("../core/secret-cipher");
const { getExecutionContext } = require("../tools/context");
const authorization = require("../core/authorization");

let kernel = null;
try { kernel = require("../platform/kernel"); } catch { kernel = null; }

// Resolve `secret:<name>` to plaintext, or null when absent. Authorization
// failures throw before decryption so callers cannot fall through to a weaker
// credential source.
function authorizeSecretUse(context, resource) {
  const principalId = context?.authIdentity?.principal_id || null;
  if (!principalId) return { ok: true, compatibility: true };
  return authorization.authorize({ principalId, permission: "secrets.use", resource });
}

function resolveSecretRef(secretRef, { context = getExecutionContext(), requireIdentity = false } = {}) {
  if (!secretRef || typeof secretRef !== "string") return null;
  const match = /^secret:(.+)$/.exec(secretRef);
  if (!match) return null;
  const decision = authorizeSecretUse(context, match[1]);
  if (requireIdentity && !context?.authIdentity?.principal_id) {
    const error = new Error("secret use requires an authenticated principal");
    error.code = "unauthenticated";
    throw error;
  }
  if (!decision.ok) {
    const error = new Error("secret use is not authorized");
    error.code = decision.code;
    throw error;
  }
  try {
    const secret = loadSecrets()[match[1]];
    if (secret) {
      const value = decryptSecret(secret);
      if (value) return value;
    }
  } catch {
    // Secret store unavailable/unreadable: fall through to null so the caller
    // can apply its own backwards-compatible fallback rather than failing here.
  }
  return null;
}

// The active connector of a given type usable for live calls, or null. "Usable"
// means enabled or healthy; registered/configured are not yet live, and
// disabled/error/retired are excluded.
function getActiveConnector(type) {
  if (!kernel || typeof kernel.listConnectors !== "function") return null;
  for (const state of ["healthy", "enabled"]) {
    try {
      const list = kernel.listConnectors({ type, state, limit: 1 });
      if (list && list.length) return list[0];
    } catch {
      // best-effort
    }
  }
  return null;
}

// Resolve a connector's credential (plaintext) from its secret_ref, or null.
function resolveConnectorCredential(connector, options = {}) {
  if (!connector) return null;
  return resolveSecretRef(connector.secret_ref, options);
}

module.exports = { resolveSecretRef, getActiveConnector, resolveConnectorCredential, authorizeSecretUse };
