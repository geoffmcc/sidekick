const { redactSensitive, redactSensitiveKeysDeep, isSensitiveKey } = require("../redact");
const { DEFINITIONS } = require("../core/errors");

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
  return {
    content: [{ type: "text", text: code === "handler_error" ? "Error: " + safeMessage : safeMessage }],
    isError: true,
    code,
    status: metadata.status || code,
    httpStatus: metadata.httpStatus || definition?.[0],
    retryable: metadata.retryable ?? definition?.[1] ?? false,
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
    auditFailed: metadata.auditFailed,
  };
}

function normalizeResult(result) {
  if (result && result.__sidekickExposeSensitiveOnce === true) {
    const exposed = { ...result };
    delete exposed.__sidekickExposeSensitiveOnce;
    return exposed;
  }
  if (result && Array.isArray(result.content)) return { ...result, content: sanitizeContent(result.content) };
  if (result && result.isError) return { ...result, content: sanitizeContent(result.content) };
  const serialized = typeof result === "string" ? result : JSON.stringify(result);
  return textResult(serialized === undefined ? "null" : serialized);
}

module.exports = { textResult, errorResult, normalizeResult, sanitizeText, sanitizeContent };
