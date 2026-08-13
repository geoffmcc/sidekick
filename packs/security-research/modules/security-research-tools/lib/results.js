"use strict";

/**
 * Result shaping for the security-research pack.
 *
 * Tools return the standard Sidekick tool-result envelope
 * ({ content: [{ type: "text", text }], isError?, code? }). Sidekick's result
 * layer sanitizes this text before it leaves the process, so handlers never
 * redact here — but they also never place raw evidence bytes, tokens, or secret
 * references into a result payload in the first place.
 */

const { ResearchError } = require("./errors");

function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function ok(payload) {
  return jsonResult({ ok: true, ...payload });
}

/**
 * Shape an error result. Accepts a ResearchError (preferred), a plain Error, or
 * a string. Kernel invariant violations surface as plain Errors with useful
 * messages; map them to a stable code so the caller is not left guessing.
 */
function errorResult(error, fallbackCode = "invalid_input") {
  if (error instanceof ResearchError) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message, code: error.code, details: error.details }, null, 2) }],
      isError: true,
      code: error.code,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = (error && error.code && typeof error.code === "string") ? error.code : fallbackCode;
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, code }, null, 2) }],
    isError: true,
    code,
  };
}

module.exports = { jsonResult, ok, errorResult };
