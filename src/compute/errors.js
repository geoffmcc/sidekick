class ComputeError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ComputeError";
    this.code = code;
    this.details = details;
  }
}

class ProviderUnavailableError extends ComputeError {
  constructor(providerId, reason = "unavailable") {
    super(`Provider ${providerId} is ${reason}`, "PROVIDER_UNAVAILABLE", { providerId, reason });
    this.name = "ProviderUnavailableError";
  }
}

class ModelNotAvailableError extends ComputeError {
  constructor(modelId, providerId) {
    super(`Model ${modelId} not available on provider ${modelId}`, "MODEL_NOT_AVAILABLE", { modelId, providerId });
    this.name = "ModelNotAvailableError";
  }
}

class RoutingError extends ComputeError {
  constructor(message, details = {}) {
    super(message, "ROUTING_FAILED", details);
    this.name = "RoutingError";
  }
}

class JobError extends ComputeError {
  constructor(message, code = "JOB_ERROR", details = {}) {
    super(message, code, details);
    this.name = "JobError";
  }
}

class LeaseExpiredError extends JobError {
  constructor(jobId, leaseId) {
    super(`Lease expired for job ${jobId}`, "LEASE_EXPIRED", { jobId, leaseId });
    this.name = "LeaseExpiredError";
  }
}

class WorkerRevokedError extends ComputeError {
  constructor(workerId) {
    super(`Worker ${workerId} has been revoked`, "WORKER_REVOKED", { workerId });
    this.name = "WorkerRevokedError";
  }
}

class EnrollmentError extends ComputeError {
  constructor(message, details = {}) {
    super(message, "ENROLLMENT_FAILED", details);
    this.name = "EnrollmentError";
  }
}

class DataClassificationError extends ComputeError {
  constructor(dataClass, allowedClasses) {
    super(`Data classification '${dataClass}' not allowed. Allowed: ${allowedClasses.join(", ")}`, "DATA_CLASSIFICATION_VIOLATION", { dataClass, allowedClasses });
    this.name = "DataClassificationError";
  }
}

class TrustViolationError extends ComputeError {
  constructor(message, details = {}) {
    super(message, "TRUST_VIOLATION", details);
    this.name = "TrustViolationError";
  }
}

class ExecutorError extends ComputeError {
  constructor(message, code = "EXECUTOR_ERROR", details = {}) {
    super(message, code, details);
    this.name = "ExecutorError";
  }
}

class ResourceLimitError extends ComputeError {
  constructor(message, details = {}) {
    super(message, "RESOURCE_LIMIT", details);
    this.name = "ResourceLimitError";
  }
}

class EmptyProviderResultError extends ComputeError {
  constructor(providerId, details = {}) {
    super(`Provider ${providerId} returned empty or whitespace-only result`, "EMPTY_PROVIDER_RESULT", { providerId, ...details });
    this.name = "EmptyProviderResultError";
  }
}

class ResultValidationError extends ComputeError {
  constructor(reason, details = {}) {
    super(`Result validation failed: ${reason}`, "RESULT_VALIDATION_FAILED", { reason, ...details });
    this.name = "ResultValidationError";
  }
}

const CIRCUIT_STATES = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
});

const PROVIDER_HEALTH_STATES = Object.freeze([
  "healthy",
  "degraded",
  "unreachable",
  "auth_failure",
  "model_unavailable",
  "rate_limited",
  "circuit_open",
  "disabled",
  "maintenance",
  "unknown",
]);

const WORKER_STATES = Object.freeze([
  "online",
  "offline",
  "degraded",
  "busy",
  "maintenance",
  "draining",
  "revoked",
  "sleeping",
]);

const JOB_STATES = Object.freeze([
  "created",
  "waiting_for_approval",
  "queued",
  "leased",
  "starting",
  "running",
  "cancelling",
  "completed",
  "failed",
  "expired",
  "cancelled",
  "retry_wait",
  "dead_letter",
]);

const JOB_TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
  "dead_letter",
]);

const JOB_TRANSITIONS = Object.freeze({
  created: ["waiting_for_approval", "queued", "cancelled", "failed"],
  waiting_for_approval: ["queued", "cancelled", "failed"],
  queued: ["leased", "cancelled", "expired", "failed"],
  leased: ["starting", "cancelled", "expired", "failed"],
  starting: ["running", "cancelling", "failed", "cancelled"],
  running: ["completed", "failed", "cancelling", "expired"],
  cancelling: ["cancelled", "completed", "failed"],
  retry_wait: ["queued", "cancelled", "dead_letter"],
  completed: [],
  failed: ["retry_wait", "dead_letter"],
  expired: ["retry_wait", "dead_letter"],
  cancelled: [],
  dead_letter: [],
});

const DATA_CLASSIFICATIONS = Object.freeze([
  "public",
  "internal",
  "private",
  "sensitive",
  "restricted",
]);

const TRUST_LEVELS = Object.freeze([
  "untrusted",
  "limited",
  "trusted",
  "privileged",
]);

const WORKLOAD_CLASSES = Object.freeze([
  "interactive-heavy",
  "interactive-light",
  "background",
  "embedding-batch",
  "vision-heavy",
  "transcription-heavy",
  "independent-review",
  "emergency-fallback",
]);

module.exports = {
  ComputeError,
  ProviderUnavailableError,
  ModelNotAvailableError,
  RoutingError,
  JobError,
  LeaseExpiredError,
  WorkerRevokedError,
  EnrollmentError,
  DataClassificationError,
  TrustViolationError,
  ExecutorError,
  ResourceLimitError,
  EmptyProviderResultError,
  ResultValidationError,
  CIRCUIT_STATES,
  PROVIDER_HEALTH_STATES,
  WORKER_STATES,
  JOB_STATES,
  JOB_TERMINAL_STATES,
  JOB_TRANSITIONS,
  DATA_CLASSIFICATIONS,
  TRUST_LEVELS,
  WORKLOAD_CLASSES,
};
