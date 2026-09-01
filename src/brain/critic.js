"use strict";

const MAX_FINDINGS = 24;
function text(value, max = 300) { return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function critique(taskSpec, plan) {
  const findings = [];
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) findings.push({ code: "missing_steps", severity: "high", message: "plan has no executable steps" });
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const hasTool = steps.some(step => step.type === "tool");
  if (taskSpec?.requires_live_evidence && !hasTool) findings.push({ code: "missing_live_evidence", severity: "high", message: "TaskSpec requires live evidence but plan has no tool step" });
  if (taskSpec?.read_only && steps.some(step => step.type === "tool" && step.effect && step.effect !== "read_only")) findings.push({ code: "read_only_violation", severity: "critical", message: "read-only TaskSpec contains a mutating effect" });
  return { version: 3, disposition: findings.length ? "revise" : "accept", findings: findings.slice(0, MAX_FINDINGS).map(item => ({ code: text(item.code, 80), severity: text(item.severity, 20), message: text(item.message) })) };
}
module.exports = { MAX_FINDINGS, critique };
