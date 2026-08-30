"use strict";

const { redactSensitiveKeysDeep } = require("../redact");

function sanitize(value) {
  return redactSensitiveKeysDeep(value);
}

function formatCertificationText(report) {
  const safe = sanitize(report || {});
  const summary = safe.summary || {};
  const lines = [
    `Agent certification ${safe.version || "unknown"}: ${safe.verdict || "unknown"}`,
    `Scenarios: ${summary.total || 0} total, ${summary.passed || 0} passed, ${summary.failed || 0} failed, ${summary.skipped || 0} skipped, ${summary.blocked || 0} blocked`,
  ];
  for (const result of safe.results || []) {
    const reason = result.reason ? ` (${result.reason})` : "";
    lines.push(`${result.status.toUpperCase().padEnd(7)} ${result.id}${reason}`);
  }
  return lines.join("\n");
}

module.exports = { sanitize, formatCertificationText };
