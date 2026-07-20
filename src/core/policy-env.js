"use strict";

// Shared parsing for the comma-separated policy lists Sidekick reads from the
// environment, and for the per-source environment variable names those lists
// live under. Used by both the tool policy in src/tools-legacy.js and the
// filesystem path policy in src/tools/path-policy.js, so it stays a leaf with
// no internal requires.

function parsePolicyList(value) {
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function sourceEnvName(source, suffix) {
  return "SIDEKICK_" + String(source || "unknown").toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_" + suffix;
}

module.exports = { parsePolicyList, sourceEnvName };
