const { redactSensitive, redactSensitiveKeysDeep, isSensitiveKey } = require("../redact");
const { DEFINITIONS } = require("../core/errors");

const RESULT_STATUSES = Object.freeze(["succeeded", "partial", "failed", "unavailable", "denied", "approval_required", "cancelled"]);
const STATUS_BY_CODE = Object.freeze({
  validation_failed: "failed", invalid_arguments: "failed", policy_denied: "denied", authorization_denied: "denied",
  approval_required: "approval_required", cancelled: "cancelled", cancellation: "cancelled", capability_unavailable: "unavailable",
  dependency_missing: "unavailable", provider_unavailable: "unavailable", approval_continuation_unavailable: "unavailable",
});

function canonicalStatus(value, fallback = "succeeded") {
  const status = String(value || "").toLowerCase();
  if (RESULT_STATUSES.includes(status)) return status;
  if (["success", "completed", "passed", "available", "ok"].includes(status)) return "succeeded";
  if (["failure", "error", "failed"].includes(status)) return "failed";
  if (["waiting", "awaiting_approval", "approval"].includes(status)) return "approval_required";
  if (["aborted", "canceled", "cancelled"].includes(status)) return "cancelled";
  if (["not_configured", "degraded_dependency"].includes(status)) return "unavailable";
  return fallback;
}

function sanitizeText(value) {
  const text = value && value.stack ? value.message : String(value == null ? "" : value);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.stringify(redactResultValue(JSON.parse(text)), null, 2); } catch {}
  }
  return redactSensitive(text)
    .replace(/\n\s*at\s+[^\n]+/g, "")
    .replace(/(Authorization\s*:\s*)(?:Bearer\s+)?[^\s]+/gi, "$1[REDACTED]");
}

function redactResultValue(value, key = "") {
  // Status metadata such as credentialState and hasCredential is not secret;
  // only redact fields that carry the credential itself.
  const metadataKey = /(?:state|status|type|id|at)$/i.test(key) || /^has[A-Z]/.test(key);
  if (isSensitiveKey(key) && !metadataKey) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactResultValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactResultValue(childValue, childKey)]));
  return typeof value === "string" ? redactSensitive(value) : value;
}

function sanitizeContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map(item => {
    if (!item || typeof item !== "object") return item;
    if (item.type === "text") return { ...item, text: sanitizeText(item.text) };
    return item;
  });
}

function textResult(text, metadata = {}) {
  return { content: [{ type: "text", text: sanitizeText(text) }] };
}

function errorResult(error, code = "handler_error", metadata = {}) {
  const safeMessage = sanitizeText(error && error.message ? error.message : String(error || "Unknown error"));
  const definition = DEFINITIONS[code];
  const status = canonicalStatus(metadata.status || STATUS_BY_CODE[code], code === "approval_required" ? "approval_required" : "failed");
  return {
    content: [{ type: "text", text: code === "handler_error" ? "Error: " + safeMessage : safeMessage }],
    isError: true,
    code,
    status,
    result_status: status,
    httpStatus: metadata.httpStatus || definition?.[0],
    retryable: metadata.retryable ?? definition?.[1] ?? false,
    retry_safe: metadata.retry_safe ?? metadata.retryable ?? definition?.[1] ?? false,
    subsystem: metadata.subsystem || "platform",
    correlationId: metadata.correlationId || null,
    details: metadata.details && typeof metadata.details === "object" ? metadata.details : {},
    approvalRequired: metadata.approvalRequired,
    approvalId: metadata.approvalId,
    timedOut: metadata.timedOut,
    cancelled: metadata.cancelled,
    operationMayContinue: metadata.operationMayContinue,
    operationId: metadata.operationId,
    idempotencyKey: metadata.idempotencyKey,
    evidence_refs: Array.isArray(metadata.evidence_refs) ? metadata.evidence_refs.slice(0, 100) : [],
    warnings: Array.isArray(metadata.warnings) ? metadata.warnings.slice(0, 50) : [],
    limitations: Array.isArray(metadata.limitations) ? metadata.limitations.slice(0, 50) : [],
    dependency_results: Array.isArray(metadata.dependency_results) ? metadata.dependency_results.slice(0, 50) : [],
    approval_state: metadata.approval_state || (status === "approval_required" ? "required" : "not_required"),
    partial_completion: metadata.partial_completion || null,
    recovery: metadata.recovery || null,
    auditFailed: metadata.auditFailed,
  };
}

function structuredResult(payload, metadata = {}) {
  const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const explicitStatus = value.result_status || value.status || value.state;
  const status = canonicalStatus(explicitStatus, value.ok === false ? "failed" : "succeeded");
  // Preserve an established domain lifecycle label (for example
  // `task_runnable`) on `status`; `result_status` is the stable execution
  // classification consumed by generic callers.
  const exposedStatus = explicitStatus && !RESULT_STATUSES.includes(String(explicitStatus).toLowerCase()) && value.ok !== false
    ? explicitStatus
    : status;
  const ok = status === "succeeded" || status === "partial";
  return {
    ...value,
    // `ok` is execution success. A domain assertion may be false while the
    // assertion operation itself succeeded; callers should inspect
    // `finding_ok` in that explicit-success shape.
    ok: explicitStatus && ok ? true : value.ok === undefined ? ok : value.ok === true && ok,
    ...(explicitStatus && ok && value.ok === false ? { finding_ok: false } : {}),
    status: exposedStatus,
    result_status: status,
    code: value.code || metadata.code || (status === "succeeded" ? null : `result_${status}`),
    retry_safe: value.retry_safe ?? value.retryable ?? metadata.retry_safe ?? false,
    evidence_refs: Array.isArray(value.evidence_refs) ? value.evidence_refs.slice(0, 100) : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 50) : [],
    limitations: Array.isArray(value.limitations) ? value.limitations.slice(0, 50) : [],
    dependency_results: Array.isArray(value.dependency_results) ? value.dependency_results.slice(0, 50) : [],
    approval_state: value.approval_state || (status === "approval_required" ? "required" : "not_required"),
    partial_completion: value.partial_completion || (status === "partial" ? { completed: true } : null),
    recovery: value.recovery || value.next_action || null,
  };
}

function decodeStructuredContent(result) {
  const text = result?.content?.filter(item => item?.type === "text").map(item => item.text || "").join("\n").trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

function normalizeResult(result, { allowSensitiveOnce = false } = {}) {
  if (allowSensitiveOnce) {
    const { unwrap } = require("./sensitive-result");
    const exposed = unwrap(result);
    if (exposed !== null) return { content: [{ type: "text", text: JSON.stringify(exposed, null, 2) }] };
  }
  if (result && Array.isArray(result.content)) {
    const payload = decodeStructuredContent(result);
    if (payload) {
      const normalized = structuredResult(payload, result);
      return { ...result, ...normalized, ...(result.isError || !normalized.ok ? { isError: true } : {}), content: sanitizeContent(result.content) };
    }
    const canonical = result.isError ? canonicalStatus(result.status, "failed") : "succeeded";
    const exposedStatus = !result.isError && result.status && !RESULT_STATUSES.includes(String(result.status).toLowerCase())
      ? result.status
      : canonical;
    return { ...result, ok: !result.isError, status: exposedStatus, result_status: canonical, retry_safe: result.retry_safe ?? result.retryable ?? false, content: sanitizeContent(result.content) };
  }
  if (result && result.isError) return { ...result, ...structuredResult(result, result), isError: true, content: sanitizeContent(result.content) };
  const serialized = typeof result === "string" ? result : JSON.stringify(result);
  return textResult(serialized === undefined ? "null" : serialized);
}

module.exports = { RESULT_STATUSES, canonicalStatus, textResult, errorResult, structuredResult, normalizeResult, sanitizeText, sanitizeContent };
