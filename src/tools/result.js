const { redactSensitive } = require("../redact");

function sanitizeText(value) {
  const text = value && value.stack ? value.message : String(value == null ? "" : value);
  return redactSensitive(text)
    .replace(/\n\s*at\s+[^\n]+/g, "")
    .replace(/(Authorization\s*:\s*)(?:Bearer\s+)?[^\s]+/gi, "$1[REDACTED]");
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
  return {
    content: [{ type: "text", text: code === "handler_error" ? "Error: " + safeMessage : safeMessage }],
    isError: true,
    code,
    status: metadata.status || code,
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
  if (result && Array.isArray(result.content)) return { ...result, content: sanitizeContent(result.content) };
  if (result && result.isError) return { ...result, content: sanitizeContent(result.content) };
  return textResult(typeof result === "string" ? result : JSON.stringify(result));
}

module.exports = { textResult, errorResult, normalizeResult, sanitizeText, sanitizeContent };
