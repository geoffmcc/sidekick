"use strict";

function sanitizeMcpLogLabel(value, fallback = "invalid") {
  if (typeof value !== "string") return fallback;
  return value.replace(/[^\x20-\x7E]/g, "?").slice(0, 128);
}

module.exports = { sanitizeMcpLogLabel };
