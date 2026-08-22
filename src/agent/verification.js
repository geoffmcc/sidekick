"use strict";

const STATUSES = Object.freeze(["verified", "partially_verified", "incomplete", "contradicted", "unable_to_verify", "waiting_for_approval", "waiting_for_information", "budget_exhausted"]);

function clean(value, max = 500) { return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }

// Verification consumes evidence; it never creates authority and never calls a
// tool. Any live verification capability must be selected and dispatched by
// the normal Agent/dispatcher loop before this decision is recorded.
function verifyTaskResult({ criteria = [], evidence = [], result = "", requires_live_evidence = false, terminal_state = "completed" } = {}) {
  const criterionList = Array.isArray(criteria) ? criteria.slice(0, 50).map(item => clean(item)).filter(Boolean) : [];
  const evidenceList = Array.isArray(evidence) ? evidence.slice(0, 100).map(item => ({ tool: clean(item.tool, 120), ok: item.ok !== false, reference: clean(item.reference || item.id, 160), text: clean(item.text, 800) })) : [];
  const usable = evidenceList.filter(item => item.ok && item.reference);
  const contradictions = evidenceList.filter(item => /\b(?:contradict|failed|error|unavailable|denied)\b/i.test(item.text));
  if (terminal_state === "cancelled") return { status: "incomplete", criteria_checked: 0, reason: "task cancelled", evidence: usable };
  if (terminal_state === "timed_out") return { status: "budget_exhausted", criteria_checked: 0, reason: "task budget or deadline exhausted", evidence: usable };
  if (terminal_state === "waiting_for_approval") return { status: "waiting_for_approval", criteria_checked: 0, reason: "approval is outstanding", evidence: usable };
  if (contradictions.length && !usable.length) return { status: "contradicted", criteria_checked: 0, reason: "available evidence contains only failure or contradictory observations", evidence: [] };
  if (requires_live_evidence && usable.length === 0) return { status: "unable_to_verify", criteria_checked: 0, reason: "no current evidence reference was produced", evidence: [] };
  if (!result || !clean(result, 20_000)) return { status: "incomplete", criteria_checked: 0, reason: "no result was produced", evidence: usable };
  if (criterionList.length === 0) return { status: usable.length ? "partially_verified" : "unable_to_verify", criteria_checked: 0, reason: "no explicit success criteria were supplied", evidence: usable };
  const covered = criterionList.filter(criterion => usable.some(item => item.text.toLowerCase().includes(criterion.toLowerCase())));
  const status = covered.length === criterionList.length && !contradictions.length ? "verified" : covered.length ? "partially_verified" : "unable_to_verify";
  return { status, criteria_checked: criterionList.length, criteria_covered: covered.length, criteria: criterionList.map(text => ({ text, state: covered.includes(text) ? "supported" : "unverified" })), evidence: usable, reason: status === "verified" ? "every criterion has supporting evidence" : "one or more criteria lack independent supporting evidence" };
}

module.exports = { STATUSES, verifyTaskResult };
