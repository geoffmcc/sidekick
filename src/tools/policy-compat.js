"use strict";

const { stripSidekickPrefix } = require("../core/tool-name");

const RISK_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

function createPolicyCompat({ parsePolicyList, sourceEnvName, getToolRisk, getCurrentSource }) {
function getPolicyEntries(source, suffixes) {
  const entries = [];
  for (const suffix of suffixes) {
    entries.push(...parsePolicyList(process.env["SIDEKICK_" + suffix]));
    entries.push(...parsePolicyList(process.env[sourceEnvName(source, suffix)]));
  }
  return entries;
}

function findPolicyListMatch(entries, toolName, risk) {
  // Case-fold the tool name symmetrically with the entries so a mixed-case
  // requested name cannot evade a blocklist entry.
  const canonical = stripSidekickPrefix(String(toolName || "").toLowerCase());
  return entries.find(entry => {
    const normalized = stripSidekickPrefix(entry.toLowerCase());
    return normalized === canonical || normalized === ("risk:" + risk);
  });
}

function getApprovalMode(source = getCurrentSource()) {
  const sourceMode = process.env[sourceEnvName(source, "APPROVAL_MODE")];
  // Omitted approval configuration must protect explicitly allowed high-risk
  // tools as well as the restricted policy's default deny. Existing explicit
  // values, including `off`, remain authoritative for compatibility.
  return (sourceMode || process.env.SIDEKICK_APPROVAL_MODE || "strict").toLowerCase();
}

function getApprovalEntries(source, suffixes) {
  const entries = [];
  for (const suffix of suffixes) {
    entries.push(...parsePolicyList(process.env["SIDEKICK_APPROVAL_" + suffix]));
    entries.push(...parsePolicyList(process.env[sourceEnvName(source, "APPROVAL_" + suffix)]));
  }
  return entries;
}

function getApprovalDecision(toolName, source = getCurrentSource(), args = undefined) {
  const risk = getToolRisk(toolName, args);
  const mode = getApprovalMode(source);
  const requiredEntries = getApprovalEntries(source, ["REQUIRED_TOOLS"]);
  const exemptEntries = getApprovalEntries(source, ["EXEMPT_TOOLS"]);

  if (mode === "off" || mode === "disabled") {
    return { required: false, source, mode, risk, reason: "approval mode is off" };
  }

  const exemptMatch = findPolicyListMatch(exemptEntries, toolName, risk);
  if (exemptMatch) {
    return { required: false, source, mode, risk, reason: "exempt from approval", matched: exemptMatch, list: "exempt" };
  }

  const requiredMatch = findPolicyListMatch(requiredEntries, toolName, risk);
  if (requiredMatch) {
    return { required: true, source, mode, risk, reason: "matched approval requirement", matched: requiredMatch, list: "required" };
  }

  if (mode === "strict" && RISK_ORDER[risk] >= RISK_ORDER.high) {
    return { required: true, source, mode, risk, reason: "strict mode requires approval for high and critical risk tools", list: "mode" };
  }

  if (mode === "risky" && risk === "critical") {
    return { required: true, source, mode, risk, reason: "risky mode requires approval for critical risk tools", list: "mode" };
  }

  return { required: false, source, mode, risk, reason: "approval not required" };
}

function getToolPolicyDecision(toolName, source = getCurrentSource(), args = undefined) {
  const risk = getToolRisk(toolName, args);
  const sourceMode = process.env[sourceEnvName(source, "TOOL_POLICY")];
  // A fresh installation must not expose shell, infrastructure, or other
  // high-impact tools merely because the operator omitted policy settings.
  // Existing explicit configuration still wins for compatibility.
  const mode = (sourceMode || process.env.SIDEKICK_TOOL_POLICY || "restricted").toLowerCase();
  const allowedEntries = getPolicyEntries(source, ["ALLOWED_TOOLS"]);
  const blockedEntries = getPolicyEntries(source, ["DISABLED_TOOLS", "BLOCKED_TOOLS"]);

  const blockedMatch = findPolicyListMatch(blockedEntries, toolName, risk);
  if (blockedMatch) {
    return { allowed: false, source, mode, risk, reason: "blocked by tool policy", matched: blockedMatch, list: "blocked" };
  }

  if (allowedEntries.length > 0) {
    const allowedMatch = findPolicyListMatch(allowedEntries, toolName, risk);
    return {
      allowed: Boolean(allowedMatch),
      source,
      mode,
      risk,
      reason: allowedMatch ? "allowed by explicit allowlist" : "not in explicit allowlist",
      matched: allowedMatch,
      list: "allowed"
    };
  }

  if (mode === "restricted" && RISK_ORDER[risk] >= RISK_ORDER.high) {
    return { allowed: false, source, mode, risk, reason: "restricted policy blocks high and critical risk tools", list: "mode" };
  }

  return { allowed: true, source, mode, risk, reason: "allowed" };
}

function enforceToolPolicy(toolName, source = getCurrentSource(), args = undefined) {
  const decision = getToolPolicyDecision(toolName, source, args);
  if (decision.allowed) return null;
  return {
    content: [{
      type: "text",
      text: `Tool blocked by policy: ${toolName} (${decision.risk} risk, source=${decision.source}, mode=${decision.mode}). ${decision.reason}.`
    }],
    isError: true
  };
}

  return { getPolicyEntries, findPolicyListMatch, getApprovalMode, getApprovalEntries, getApprovalDecision, getToolPolicyDecision, enforceToolPolicy };
}

module.exports = { createPolicyCompat };
