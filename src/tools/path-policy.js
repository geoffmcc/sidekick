"use strict";

const path = require("path");
const { parsePolicyList, sourceEnvName } = require("../core/policy-env");
const toolContext = require("./context");

// Filesystem path policy: the security boundary that decides whether a tool
// invocation may touch a given path, based on the allow/deny lists configured
// for the current execution source.
//
// Policy is open by default. A deny match always wins. When any allow entry is
// configured, a path must match one to be permitted. Environment variables are
// read on every call so configuration changes take effect without a restart,
// and the execution source is resolved per call from the request-scoped
// context.
//
// This module requires only `path`, `../core/policy-env`, and `./context`, so
// descriptor families can depend on it without requiring `src/tools-legacy.js`
// at module top level.

function normalizePolicyPath(filePath) {
  return path.resolve(String(filePath || ""));
}

function pathPolicyEntries(source, suffix) {
  return [
    ...parsePolicyList(process.env["SIDEKICK_" + suffix]),
    ...parsePolicyList(process.env[sourceEnvName(source, suffix)])
  ];
}

// Containment test for a single entry. This is not an authorization check on
// its own: it knows nothing about deny-list precedence. Call
// getPathPolicyDecision or enforcePathPolicy to make a policy decision.
// Matching is lexical — paths are resolved, not canonicalized through
// realpath — so a symlink is judged by where it sits, not by where it points.
function pathMatchesPolicyEntry(filePath, entry) {
  const normalizedPath = normalizePolicyPath(filePath);
  const normalizedEntry = normalizePolicyPath(entry);
  const relative = path.relative(normalizedEntry, normalizedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findPathPolicyMatch(entries, filePath) {
  return entries.find(entry => pathMatchesPolicyEntry(filePath, entry));
}

function getPathPolicyDecision(filePath, operation = "access", source = toolContext.getExecutionSource() || "unknown") {
  const target = normalizePolicyPath(filePath);
  const allowedEntries = pathPolicyEntries(source, "ALLOWED_PATHS");
  const deniedEntries = pathPolicyEntries(source, "DENIED_PATHS");
  const deniedMatch = findPathPolicyMatch(deniedEntries, target);

  if (deniedMatch) {
    return { allowed: false, source, operation, path: target, reason: "path denied by policy", matched: deniedMatch, list: "denied" };
  }

  if (allowedEntries.length > 0) {
    const allowedMatch = findPathPolicyMatch(allowedEntries, target);
    return {
      allowed: Boolean(allowedMatch),
      source,
      operation,
      path: target,
      reason: allowedMatch ? "path allowed by policy" : "path not in allowed paths",
      matched: allowedMatch || null,
      list: "allowed"
    };
  }

  return { allowed: true, source, operation, path: target, reason: "path policy is open" };
}

function enforcePathPolicy(filePath, operation = "access") {
  const decision = getPathPolicyDecision(filePath, operation);
  if (decision.allowed) return null;
  return {
    content: [{
      type: "text",
      text: `Path blocked by policy: ${decision.path} (source=${decision.source}, operation=${decision.operation}). ${decision.reason}.`
    }],
    isError: true
  };
}

// pathPolicyEntries and findPathPolicyMatch stay module-private, as they were
// in src/tools-legacy.js. Export them if a caller ever genuinely needs them.
module.exports = {
  normalizePolicyPath,
  pathMatchesPolicyEntry,
  getPathPolicyDecision,
  enforcePathPolicy,
};
