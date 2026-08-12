"use strict";

// Nested-dispatch seam for descriptor families (Track B slice B-6).
//
// Families must never require src/tools-legacy.js — and must not top-level
// require ../dispatcher either: dispatcher requires ./registry, registry
// requires ./families, so a family pulling the dispatcher at module init
// captures an in-flight module whose exports are permanently undefined
// (verified for both boot orders). This module has ZERO top-level requires;
// the dispatcher is resolved at call time, when every module is complete for
// all entrypoints (index.js, agent.js, dashboard.js, brain/resume.js).
//
// callTool reproduces the legacy wrapper byte-for-byte in call shape —
// dispatchTool({ name, args, context: options }), NOT dispatcher.callTool —
// so nested-context derivation is identical to the pre-extraction behavior.
// Only dispatchTool is exposed this way; the privileged
// executeAuthorizedTaskStep seam stays unreachable from family code.

async function callTool(name, args, options = {}) {
  return require("./dispatcher").dispatchTool({ name, args, context: options });
}

module.exports = { callTool };
