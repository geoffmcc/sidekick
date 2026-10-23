"use strict";

const ESCALATION_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

/**
 * An escalation decision is its own approval boundary. Its reference is
 * derived from the immutable escalation record being decided; a task's
 * unrelated tool approval must never be reusable as approval for an
 * escalation.
 */
function createEscalationApprovalRef(escalationId) {
  if (typeof escalationId !== "string" || !ESCALATION_ID.test(escalationId)) {
    throw new Error("invalid escalation id");
  }
  return `approval:escalation:${escalationId}`;
}

function validateEscalationApprovalRef(approvalRef, escalationId) {
  let expected;
  try { expected = createEscalationApprovalRef(escalationId); }
  catch { return { ok: false, reason: "invalid_escalation_id" }; }
  if (approvalRef !== expected) return { ok: false, reason: "approval_escalation_mismatch" };
  return { ok: true };
}

module.exports = Object.freeze({ createEscalationApprovalRef, validateEscalationApprovalRef });
