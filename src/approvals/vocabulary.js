"use strict";

/**
 * Closed vocabularies for approval continuation
 * (docs/adr-approval-continuation.md §4.4).
 *
 * "Errors are codes, not prose." `error_code`, `outcome_code`, and
 * `reason_code` are safe to index, aggregate, and display without a decryption
 * key. Where a human needs more than a code, the detail is deliberately
 * CONSTRUCTED from known-safe components — never a captured exception message —
 * and stored in the matching `*_encrypted` column.
 *
 * Error text is the most common accidental exfiltration path in this
 * codebase's history: the redaction gap fixed in PR #141 existed because a raw
 * provider message carrying a credential reached the transcript verbatim. These
 * columns must not be widened into a place where `e.message` can land, which is
 * why every writer validates against these sets.
 */

// Approval lifecycle (§2). "Live" statuses hold a task's authorization slot.
const APPROVAL_STATUSES = Object.freeze([
  "pending",
  "approved",
  "executing",
  "completed",
  "denied",
  "expired",
  "cancelled",
  "superseded",
  "quarantined",
  "reconciliation_required",
  "retry_authorized",
  "failed",
]);

const LIVE_APPROVAL_STATUSES = Object.freeze([
  "pending",
  "approved",
  "executing",
  "reconciliation_required",
  "retry_authorized",
]);

const TERMINAL_APPROVAL_STATUSES = Object.freeze([
  "completed",
  "denied",
  "expired",
  "cancelled",
  "superseded",
  "quarantined",
  "failed",
]);

// Checkpoint lifecycle (§2).
const CHECKPOINT_STATES = Object.freeze([
  "waiting_for_approval",
  "runnable",
  "running",
  "reconciling",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "archived",
]);

const TERMINAL_CHECKPOINT_STATES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "archived",
]);

// Step ledger status (§4.3).
const STEP_RESULT_STATUSES = Object.freeze(["completed", "refused"]);

/**
 * Structured step outcomes returned to the planner (§7). Denial, expiry and
 * cancellation are NOT task failures — they are outcomes the planner may
 * explain or route around.
 */
const OUTCOME_CODES = Object.freeze([
  "approval_denied",
  "approval_expired",
  "approval_cancelled",
  "plan_superseded",
  "arguments_altered",
  "step_not_in_plan",
  "checkpoint_corrupt",
  "approval_missing_or_corrupt",
  "payload_unreadable",
  "task_cancelled",
  "ambiguous_execution",
  "reconciled_executed",
  "reconciliation_abandoned",
  "reconciliation_failed",
  // An action reclaimed past its bounded attempt ceiling. Distinct from expiry
  // and from ambiguity: the authorization was valid and the step was reachable,
  // but repeated claims never produced an outcome, so the task is failed rather
  // than reclaimed forever.
  "attempt_limit_exceeded",
  "task_deadline_exceeded",
]);

const ERROR_CODES = OUTCOME_CODES;

const REASON_CODES = Object.freeze([
  "ambiguous_execution",
  "orphaned_checkpoint",
  "manual_review",
  "reconciliation_resolved",
  "ledger_conflict",
  "integrity_failure",
  "lease_recovered",
  "stale_reclaim",
  "checkpoint_unrecoverable",
  "attempt_limit_exceeded",
  "task_deadline_exceeded",
]);

// Event types and reconciliation statuses are closed too. §4.4's "errors are
// codes, not prose" applies to every column an operator reads, and these are
// exactly the columns a captured exception message would drift into if a future
// caller passed one through.
const RECOVERY_EVENT_TYPES = Object.freeze([
  "ambiguous_execution",
  "orphaned_checkpoint",
  "integrity_failure",
  "reconciliation_resolved",
  "reconciliation_required",
  "lease_recovered",
  "attempt_limit_exceeded",
  "task_deadline_exceeded",
]);

const RECONCILIATION_STATUSES = Object.freeze([
  "not_required",
  "manual_review",
  "resolved",
  "safe_to_retry",
  "reclaimed_for_retry",
]);

// Reconciliation decisions (§8.2). Exactly four are permitted.
const RECONCILIATION_DECISIONS = Object.freeze([
  "confirm_executed",
  "confirm_not_executed",
  "abandon_step",
  "fail_task",
]);

/**
 * §6 Stage-2 refusal outcomes, mapped to the approval status each produces.
 * `checkpoint_corrupt` and `task_cancelled` are handled specially by T6 — the
 * first fails the task (there is no trustworthy plan to resume into), the
 * second terminalises it.
 */
const REFUSAL_STATUS_BY_OUTCOME = Object.freeze({
  approval_expired: "expired",
  approval_cancelled: "cancelled",
  plan_superseded: "superseded",
  arguments_altered: "superseded",
  step_not_in_plan: "superseded",
  checkpoint_corrupt: "superseded",
  task_cancelled: "cancelled",
});

function assertIn(set, value, label) {
  if (!set.includes(value)) {
    throw new Error(`Invalid ${label}: ${String(value).slice(0, 40)}`);
  }
  return value;
}

const assertOutcomeCode = v => assertIn(OUTCOME_CODES, v, "outcome_code");
const assertErrorCode = v => assertIn(ERROR_CODES, v, "error_code");
const assertReasonCode = v => assertIn(REASON_CODES, v, "reason_code");
const assertApprovalStatus = v => assertIn(APPROVAL_STATUSES, v, "approval status");
const assertCheckpointState = v => assertIn(CHECKPOINT_STATES, v, "checkpoint state");
const assertReconciliationDecision = v => assertIn(RECONCILIATION_DECISIONS, v, "reconciliation decision");

const assertRecoveryEventType = v => assertIn(RECOVERY_EVENT_TYPES, v, "recovery event_type");
const assertReconciliationStatus = v => assertIn(RECONCILIATION_STATUSES, v, "reconciliation_status");

module.exports = {
  RECOVERY_EVENT_TYPES,
  RECONCILIATION_STATUSES,
  assertRecoveryEventType,
  assertReconciliationStatus,
  APPROVAL_STATUSES,
  LIVE_APPROVAL_STATUSES,
  TERMINAL_APPROVAL_STATUSES,
  CHECKPOINT_STATES,
  TERMINAL_CHECKPOINT_STATES,
  STEP_RESULT_STATUSES,
  OUTCOME_CODES,
  ERROR_CODES,
  REASON_CODES,
  RECONCILIATION_DECISIONS,
  REFUSAL_STATUS_BY_OUTCOME,
  assertOutcomeCode,
  assertErrorCode,
  assertReasonCode,
  assertApprovalStatus,
  assertCheckpointState,
  assertReconciliationDecision,
};
