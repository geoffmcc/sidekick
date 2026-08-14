"use strict";

const CODES = new Set([
  "invalid_input",
  "profile_not_found",
  "profile_ambiguous",
  "not_configured",
  "authentication_failed",
  "connection_failed",
  "tls_failed",
  "timeout",
  "server_error",
  "unsupported_version",
  "unsupported_capability",
  "not_found",
  "state_conflict",
  "policy_denied",
  "unsafe_storage_state",
  "verification_failed",
]);

class JellyfinError extends Error {
  constructor(code, message, details = {}) {
    super(String(message).slice(0, 500));
    this.name = "JellyfinError";
    this.code = CODES.has(code) ? code : "server_error";
    this.details = details;
  }
}

module.exports = { JellyfinError };
