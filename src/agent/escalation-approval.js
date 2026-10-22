"use strict";

/** Validate the minimum live approval provenance for an escalation decision. */
function validateEscalationApproval(approval, { taskId, now = Date.now() } = {}) {
  if (!approval || typeof approval !== "object") return { ok: false, reason: "approval_not_found" };
  if (approval.task_id !== taskId) return { ok: false, reason: "approval_task_mismatch" };
  if (approval.status !== "approved") return { ok: false, reason: "approval_not_approved" };
  const expiresAt = Date.parse(approval.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: "approval_expired" };
  return { ok: true };
}

module.exports = Object.freeze({ validateEscalationApproval });
