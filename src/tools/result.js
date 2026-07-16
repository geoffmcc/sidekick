function textResult(text, metadata = {}) {
  return { content: [{ type: "text", text: String(text == null ? "" : text) }] };
}

function errorResult(error, code = "handler_error", metadata = {}) {
  const message = error && error.message ? error.message : String(error || "Unknown error");
  const safeMessage = message.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  return {
    content: [{ type: "text", text: code === "handler_error" ? "Error: " + safeMessage : safeMessage }],
    isError: true,
    code,
    status: metadata.status || code,
    approvalRequired: metadata.approvalRequired,
    approvalId: metadata.approvalId,
    timedOut: metadata.timedOut,
    cancelled: metadata.cancelled,
  };
}

function normalizeResult(result) {
  if (result && Array.isArray(result.content)) return result;
  if (result && result.isError) return result;
  return textResult(typeof result === "string" ? result : JSON.stringify(result));
}

module.exports = { textResult, errorResult, normalizeResult };
