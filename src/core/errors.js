"use strict";

const DEFINITIONS = Object.freeze({
  validation_failed: [400, false], authentication_required: [401, false], authorization_denied: [403, false],
  policy_denied: [403, false], approval_required: [202, true], dependency_missing: [503, true],
  capability_unavailable: [503, true], conflict: [409, true], not_found: [404, false],
  operation_ambiguous: [409, false], verification_failed: [422, false], resource_exhausted: [429, true],
  provider_failed: [502, true], timeout: [504, true], cancellation: [499, false], internal_error: [500, false],
});

class PlatformError extends Error {
  constructor(code, message, options = {}) {
    if (!DEFINITIONS[code]) code = "internal_error";
    super(String(message || code));
    this.name = "PlatformError";
    this.code = code;
    this.httpStatus = options.httpStatus || DEFINITIONS[code][0];
    this.retryable = options.retryable ?? DEFINITIONS[code][1];
    this.subsystem = options.subsystem || "platform";
    this.correlationId = options.correlationId || null;
    this.details = options.details && typeof options.details === "object" ? options.details : {};
    this.auditClassification = options.auditClassification || code;
    if (options.cause) this.cause = options.cause;
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, http_status: this.httpStatus, subsystem: this.subsystem, correlation_id: this.correlationId, details: this.details, audit_classification: this.auditClassification };
  }
}

function asPlatformError(error, fallback = "internal_error", options = {}) {
  if (error instanceof PlatformError) return error;
  return new PlatformError(fallback, options.message || "The operation could not be completed", { ...options, cause: error });
}

module.exports = { DEFINITIONS, PlatformError, asPlatformError };
