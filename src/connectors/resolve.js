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

let kernel = null;
try { kernel = require("../platform/kernel"); } catch { kernel = null; }

// Resolve `secret:<name>` to plaintext, or null. Never throws, never logs.
function resolveSecretRef(secretRef) {
  if (!secretRef || typeof secretRef !== "string") return null;
  const match = /^secret:(.+)$/.exec(secretRef);
  if (!match) return null;
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
function resolveConnectorCredential(connector) {
  if (!connector) return null;
  return resolveSecretRef(connector.secret_ref);
}

module.exports = { resolveSecretRef, getActiveConnector, resolveConnectorCredential };
