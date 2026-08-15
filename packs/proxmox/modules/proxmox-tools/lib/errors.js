"use strict";

/**
 * Structured errors for the Proxmox pack.
 *
 * Every failure a caller can see carries a stable machine code from the set
 * below, a human-readable message, and bounded details. A missing privilege
 * must never look like a network outage, and a TLS failure must never look
 * like an authentication failure — the taxonomy is the contract.
 *
 * Nothing in this file ever includes credential material. Messages that could
 * embed upstream response text are scrubbed by the caller (client.js) with the
 * resolved token split-replaced out, github-family style, before an error is
 * constructed.
 */

const ERROR_CODES = Object.freeze([
  "invalid_input",          // a model-supplied identifier failed validation
  "profile_required",       // no profile named and no default configured
  "profile_not_found",      // named profile is not in pack configuration
  "profile_invalid",        // profile configuration is malformed
  "not_configured",         // the pack has no profiles configured at all
  "credential_missing",     // profile's token_ref resolves to nothing
  "dns_failure",
  "connection_refused",
  "connection_failed",      // reset / aborted mid-flight
  "network_timeout",
  "tls_failure",
  "auth_failed",            // 401: token rejected
  "permission_denied",      // 403: token lacks a privilege
  "resource_missing",       // 404 or Proxmox "does not exist"
  "resource_exists",        // create would collide with an existing resource
  "ownership_unverified",   // provenance/ownership could not be proven
  "protected_resource",     // target is protected from the operation
  "ambiguous_state",        // mutation outcome could not be determined
  "reconciliation_required", // an operation half-landed (e.g. clone created but unstamped, delete task done but guest present); the provider state needs operator reconciliation
  "api_error",              // other Proxmox API error
  "response_invalid",       // non-JSON / oversized / malformed response
  "task_failed",            // task reached a terminal state other than OK
  "task_timeout",           // task did not reach a terminal state in time
  "guest_not_running",      // operation requires a running guest
  "lifecycle_disabled",     // profile has allow_lifecycle: false
  "unsupported_operation",  // e.g. starting a template
]);

class ProxmoxError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProxmoxError";
    this.code = ERROR_CODES.includes(code) ? code : "api_error";
    this.details = details || {};
  }
}

// Node error codes → taxonomy. TLS verification failures are recognised
// explicitly so an untrusted certificate is reported as a certificate problem
// with remediation guidance, never silently downgraded or misreported.
const TLS_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "HOSTNAME_MISMATCH",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function classifyNetworkError(error, endpointHost) {
  const code = error && (error.code || error.cause?.code);
  const host = endpointHost || "the Proxmox endpoint";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ProxmoxError("dns_failure", `DNS resolution failed for ${host}`, { cause: code });
  }
  if (code === "ECONNREFUSED") {
    return new ProxmoxError("connection_refused", `Connection refused by ${host} — is the Proxmox API listening on this port?`, { cause: code });
  }
  if (code === "ETIMEDOUT" || code === "ABORT_ERR" || (error && error.name === "AbortError")) {
    return new ProxmoxError("network_timeout", `Request to ${host} timed out`, { cause: code || "abort" });
  }
  if (TLS_ERROR_CODES.has(code)) {
    return new ProxmoxError(
      "tls_failure",
      `TLS certificate verification failed for ${host} (${code}). ` +
        "If this Proxmox installation uses its default self-signed certificate, pin its CA by setting the profile's ca_pem " +
        "to the cluster CA certificate (/etc/pve/pve-root-ca.pem on the node). TLS verification is never disabled.",
      { cause: code }
    );
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return new ProxmoxError("connection_failed", `Connection to ${host} failed (${code})`, { cause: code });
  }
  return new ProxmoxError("connection_failed", `Request to ${host} failed${code ? ` (${code})` : ""}`, { cause: code || String(error && error.message || "unknown") });
}

// HTTP status → taxonomy. `message` must already be scrubbed by the caller.
function classifyHttpError(status, message, context = {}) {
  const suffix = message ? `: ${message}` : "";
  if (status === 401) {
    return new ProxmoxError("auth_failed", `Proxmox rejected the API token (401)${suffix}`, { status, ...context });
  }
  if (status === 403) {
    return new ProxmoxError(
      "permission_denied",
      `The API token lacks a required privilege (403)${suffix}. This is an authorization problem, not an outage — see the pack's least-privilege documentation for the role each capability needs.`,
      { status, ...context }
    );
  }
  if (status === 404 || (typeof message === "string" && /does not exist/i.test(message))) {
    return new ProxmoxError("resource_missing", `Proxmox resource not found (${status})${suffix}`, { status, ...context });
  }
  return new ProxmoxError("api_error", `Proxmox API error (${status})${suffix}`, { status, ...context });
}

module.exports = { ProxmoxError, ERROR_CODES, classifyNetworkError, classifyHttpError, TLS_ERROR_CODES };
