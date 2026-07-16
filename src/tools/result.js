function textResult(text) {
  return { content: [{ type: "text", text: String(text == null ? "" : text) }] };
}

function errorResult(error) {
  const message = error && error.message ? error.message : String(error || "Unknown error");
  return { content: [{ type: "text", text: "Error: " + message }], isError: true };
}

function normalizeResult(result) {
  if (result && Array.isArray(result.content)) return result;
  if (result && result.isError) return result;
  return textResult(typeof result === "string" ? result : JSON.stringify(result));
}

module.exports = { textResult, errorResult, normalizeResult };
