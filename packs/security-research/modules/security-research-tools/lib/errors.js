"use strict";

/**
 * Structured errors for the security-research pack.
 *
 * Every failure a caller can see carries a stable machine code from the set
 * below, a human-readable message, and bounded details. The taxonomy is the
 * contract: a scope denial must never look like a missing dependency, and an
 * unsafe workspace must never look like a transient write failure, because the
 * caller (or an operator) reacts differently to each.
 *
 * Nothing in this file ever embeds a secret. Messages that could carry upstream
 * text are sanitized by Sidekick's result layer before they leave the process.
 */

const ERROR_CODES = Object.freeze([
  "invalid_input",          // a caller-supplied value failed validation
  "workspace_missing",      // no research workspace configured (config or env)
  "workspace_unsafe",       // the configured workspace resolves inside the Sidekick repo/data/store
  "dependency_missing",     // a required capability pack/tool is not installed
  "capability_unavailable", // a composed capability exists but is disabled or errored
  "policy_denied",          // Sidekick tool/module policy refused the composed call
  "scope_denied",           // the target/operation is outside the campaign scope snapshot
  "authorization_failed",   // caller identity/authorization could not be established
  "environment_failed",     // a research environment could not be prepared/validated
  "build_failed",           // a build/preparation step failed
  "probe_failed",           // a probe executed but did not complete successfully
  "timeout",                // a bounded operation exceeded its deadline
  "evidence_write_failed",  // an evidence artifact could not be written/registered
  "redaction_failed",       // a sanitized derivative could not be produced
  "comparison_failed",      // a comparison could not be computed
  "validation_failed",      // a validation step could not be recorded
  "cleanup_failed",         // workflow-owned resource cleanup did not complete
  "state_conflict",         // a durable state transition is not permitted
  "not_found",              // a referenced record does not exist
  "ambiguous_state",        // an outcome could not be determined and must not be assumed
  "unsupported_operation",  // the requested operation is not implemented for this context
]);

class ResearchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ResearchError";
    this.code = ERROR_CODES.includes(code) ? code : "invalid_input";
    this.details = details && typeof details === "object" ? details : {};
  }
}

/**
 * Translate a lower-level dispatch failure (a Sidekick tool result with
 * isError) into a research error code, so a caller sees a stable taxonomy
 * rather than the raw code of whatever capability was composed underneath.
 */
function classifyDispatchFailure(code) {
  switch (code) {
    case "policy_denied":
    case "module_permission_denied":
    case "descriptor_injection_denied":
      return "policy_denied";
    case "unknown_tool":
      return "dependency_missing";
    case "module_disabled":
      return "capability_unavailable";
    case "approval_required":
      return "policy_denied";
    case "timed_out_operation_may_continue":
    case "cancelled":
      return "timeout";
    default:
      return "probe_failed";
  }
}

module.exports = { ResearchError, ERROR_CODES, classifyDispatchFailure };
