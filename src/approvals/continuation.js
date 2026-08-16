"use strict";

/**
 * Approval continuation transactions T1–T10
 * (docs/adr-approval-continuation.md §5).
 *
 * Ten atomic units that let a Brain task parked at `waiting_for_approval`
 * resume. The dominant idiom here is raw `BEGIN IMMEDIATE` with conditional
 * UPDATEs and `changes !== 1` as the lost-race signal — the codebase's proven
 * single-claimant pattern (`compute/job-manager.js`).
 *
 * Two rules govern almost every statement below:
 *
 *  1. THE CHECKPOINT IS THE AUTHORITY ON WHICH APPROVAL IS LIVE. Every
 *     transaction that mutates a task-originated approval joins through
 *     `task_checkpoints.current_approval_id` rather than trusting an
 *     `approval_id` and `task_id` supplied independently by the caller. Two
 *     separately-supplied identifiers can disagree — a stale dashboard, a
 *     replayed request — and every row-count check would still pass.
 *
 *  2. AUTHORITATIVE STATE IS RE-READ INSIDE THE TRANSACTION, never trusted from
 *     the caller's snapshot.
 *
 * Guarantee (§8): ONE CLAIMANT OF RECORD, write-fenced by `claim_epoch`.
 * This is deliberately neither exactly-once dispatch nor an absence of
 * concurrent effects — a stalled runner may still be executing after its lease
 * is reclaimed. Recovery after a claimant dies in the ambiguous window is
 * risk-gated: at-least-once for low/medium, at-most-once with manual
 * reconciliation for high/critical/unknown.
 */

const store = require("./store");
const keys = require("./keys");
const vocab = require("./vocabulary");
const { RECONCILIATION_SPEC: RECONCILIATION_POLICY, isAuthorizedHuman: isAuthorizedHumanPolicy } = require("./reconciliation-policy");
const identity = require("../core/identity");
const authorization = require("../core/authorization");

const BOUND = "approval_id = (SELECT current_approval_id FROM task_checkpoints WHERE task_id = ?)";

/**
 * Aborts a transaction with a structured, caller-facing outcome instead of an
 * exception. Every `ROLLBACK` in the ADR that the caller must distinguish
 * (already decided, lost race, integrity failure) surfaces as one of these.
 */
class ContinuationAbort extends Error {
  constructor(code, detail = null, auditEvent = null) {
    super(`approval continuation aborted: ${code}`);
    this.name = "ContinuationAbort";
    this.code = code;
    this.detail = detail;
    // Recorded AFTER the rollback — see `tx`.
    this.auditEvent = auditEvent;
  }
}

function abort(code, detail, auditEvent) {
  throw new ContinuationAbort(code, detail, auditEvent);
}

/**
 * `BEGIN IMMEDIATE` wrapper. A ContinuationAbort rolls back and is returned as
 * `{ ok: false, code }`; any other error rolls back and propagates, because an
 * unexpected failure must not be mistaken for a decided outcome.
 *
 * AUDIT EVENTS FOR ABORTED TRANSACTIONS ARE WRITTEN AFTER THE ROLLBACK, not
 * inside it. §7.1 requires an integrity failure to "roll back, record an
 * `approval_execution_recovery_events` entry with
 * `reconciliation_status='manual_review'`, and do not wake the task" — and a
 * write made inside the transaction it is reporting on is destroyed by the very
 * rollback that makes it necessary. Getting this backwards produces a system
 * that detects corruption and then erases the only record of having detected
 * it.
 */
function tx(fn) {
  const db = store.getDb();
  store.ensureApprovalContinuationSchema();
  db.exec("BEGIN IMMEDIATE");
  let result;
  try {
    result = fn(db);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (error instanceof ContinuationAbort) {
      if (error.auditEvent) {
        // Best-effort and deliberately outside the transaction. If this throws
        // the abort code still reaches the caller: losing the audit row must
        // not turn a decided outcome into an unhandled exception.
        try { store.recordRecoveryEvent(error.auditEvent); } catch {}
      }
      return { ok: false, code: error.code, detail: error.detail };
    }
    throw error;
  }
  db.exec("COMMIT");
  return { ok: true, ...(result || {}) };
}

function expectOneRow(info, code, detail) {
  if (!info || info.changes !== 1) abort(code, detail);
}

/**
 * §8: high / critical / unknown risk is at-most-once — never redispatched
 * automatically. Anything not explicitly low or medium counts as unknown, so a
 * missing or malformed classification fails safe.
 */
function needsManualReconciliation(risk) {
  return !["low", "medium"].includes(String(risk || ""));
}

// The status observed on the row read inside this transaction. Pinning updates
// to it (rather than to a status list) is what makes a concurrent transition
// show up as `changes !== 1` instead of being silently overwritten.
function preClaimStatusOf(approval) {
  return approval.status;
}

/**
 * §7.1 "Conflicts are not automatically benign." A zero-row
 * `ON CONFLICT DO NOTHING` means *a* row exists, not that it is *the same* row.
 * Every field must agree or the transaction is an integrity failure.
 */
function assertLedgerAgreement(existing, expected) {
  if (!existing) abort("ledger_row_missing");
  const mismatched = [];
  for (const field of ["idempotency_key", "approval_id", "args_digest", "status", "outcome_code"]) {
    const a = existing[field] == null ? null : String(existing[field]);
    const b = expected[field] == null ? null : String(expected[field]);
    if (a !== b) mismatched.push(field);
  }
  if (mismatched.length) {
    // §7.1: a differing existing row is an integrity failure, not a benign
    // race. Roll back, audit it for manual review, and do not wake the task
    // into a state contradicted by its own ledger.
    abort("ledger_conflict", { mismatched }, {
      approvalId: expected.approval_id || existing.approval_id || expected.task_id,
      eventType: "integrity_failure",
      reconciliationStatus: "manual_review",
      reasonCode: "ledger_conflict",
      reasonDetail: `existing ledger row for step ${expected.step_id} disagrees on: ${mismatched.join(", ")}`,
    });
  }
}

function insertStepResult(db, row) {
  const info = db.prepare(`
    INSERT INTO task_step_results
      (task_id, step_id, plan_version, args_digest, idempotency_key,
       status, result_encrypted, result_digest, outcome_code,
       error_detail_encrypted, approval_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, step_id, plan_version) DO NOTHING
  `).run(
    row.task_id, row.step_id, row.plan_version, row.args_digest, row.idempotency_key,
    row.status, row.result_encrypted || null, row.result_digest || null, row.outcome_code || null,
    row.error_detail_encrypted || null, row.approval_id || null, row.recorded_at
  );
  if (info.changes === 0) {
    const existing = db.prepare(
      "SELECT * FROM task_step_results WHERE task_id = ? AND step_id = ? AND plan_version = ?"
    ).get(row.task_id, row.step_id, row.plan_version);
    assertLedgerAgreement(existing, row);
    return { inserted: false };
  }
  return { inserted: true };
}

const CLEAR_BINDING_SQL = `
  current_approval_id = NULL, current_step_id = NULL,
  current_args_digest = NULL, current_idempotency_key = NULL`;

// ===========================================================================
// T1 — Park
// ===========================================================================

/**
 * Persist a suspended task and the approval that authorizes its next action, in
 * one transaction. Both or neither: a checkpoint without its approval is an
 * orphan, and an approval without its checkpoint is the pre-ADR bug in durable
 * form.
 *
 * `next_step_id` is set here to the parked step and is the DURABLE RESUME
 * CURSOR (I22). Every wake and refusal path clears the four `current_*` binding
 * fields but leaves this alone, so a woken task can still locate its own
 * recorded outcome after the binding is gone.
 */
function park({
  taskId,
  rootTaskId = null,
  goal,
  classification = {},
  plan,
  stepId,
  toolName,
  args,
  risk = "unknown",
  source = "agent",
  mode = null,
  reason = null,
  requesterIdentity = null,
  requestedByPrincipalId = null,
  actorPrincipalId = null,
  actingForPrincipalId = null,
  requiresHumanApproval = false,
  approvalPolicy = null,
  timeoutMs = null,
  evidence = null,
  evidenceChars = 0,
  successfulToolEvidence = 0,
  progress = null,
  deadlineAt = null,
  platformExecutionId = null,
  rootExecutionId = null,
  now = store.nowIso(),
}) {
  if (!store.hasSecretKey()) {
    // §4.4: a checkpoint that cannot be encrypted must not be written in
    // plaintext, and a task that cannot be persisted must fail closed rather
    // than park into a state nothing can resume.
    return { ok: false, code: "secret_key_unavailable" };
  }

  const planVersion = keys.planVersion(plan);
  const planDigest = keys.planDigest(plan);
  const digest = keys.argsDigest(args);
  const idempotencyKey = keys.taskIdempotencyKey({
    taskId, stepId, planVersion, toolName, argsDigest: digest,
  });
  const approvalId = store.newApprovalId();
  const expiresAt = store.expiresAtFrom(Date.parse(now) || Date.now());

  return tx(db => {
    const info = db.prepare(`
      INSERT INTO task_checkpoints (
        task_id, root_task_id, state, goal_encrypted, classification_json,
        plan_version, plan_encrypted, plan_digest, next_step_id,
        current_approval_id, current_step_id, current_args_digest, current_idempotency_key,
        progress_encrypted, evidence_encrypted, evidence_chars, successful_tool_evidence,
        claimed_by, lease_expires_at, attempt_count, claim_epoch,
        deadline_at, created_at, updated_at,
        platform_execution_id, root_execution_id
      ) VALUES (?, ?, 'waiting_for_approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        state = 'waiting_for_approval',
        goal_encrypted = excluded.goal_encrypted,
        classification_json = excluded.classification_json,
        plan_version = excluded.plan_version,
        plan_encrypted = excluded.plan_encrypted,
        plan_digest = excluded.plan_digest,
        next_step_id = excluded.next_step_id,
        current_approval_id = excluded.current_approval_id,
        current_step_id = excluded.current_step_id,
        current_args_digest = excluded.current_args_digest,
        current_idempotency_key = excluded.current_idempotency_key,
        progress_encrypted = excluded.progress_encrypted,
        evidence_encrypted = excluded.evidence_encrypted,
        evidence_chars = excluded.evidence_chars,
        successful_tool_evidence = excluded.successful_tool_evidence,
        claimed_by = NULL,
        lease_expires_at = NULL,
        deadline_at = excluded.deadline_at,
        updated_at = excluded.updated_at
      WHERE task_checkpoints.state = 'waiting_for_approval'
    `).run(
      taskId, rootTaskId,
      store.encryptJson(goal), JSON.stringify(classification || {}),
      planVersion, store.encryptJson(plan), planDigest, stepId,
      approvalId, stepId, digest, idempotencyKey,
      store.encryptJson(progress), store.encryptJson(evidence), evidenceChars, successfulToolEvidence,
      deadlineAt, now, now,
      platformExecutionId, rootExecutionId
    );

    // T1 is the only write in this file that is neither state- nor
    // epoch-fenced, and an unguarded upsert is destructive: it would reset a
    // `running` checkpoint (silently stealing a live runner's claim, since the
    // claim fields are cleared while `claim_epoch` is not) and resurrect a
    // terminal one, leaving old approvals foreign-keyed to a checkpoint
    // describing an unrelated goal.
    //
    // This is reachable, not theoretical: `beginTaskRun` derives `task_id` from
    // `crypto.randomUUID().slice(0, 8)` — 32 bits, so collisions become likely
    // well within this deployment's lifetime, and `task_id` is this table's
    // PRIMARY KEY. The guard turns a silent clobber into a refusal.
    if (info.changes !== 1) {
      abort("checkpoint_not_parkable", { taskId });
    }

    try {
      db.prepare(`
        INSERT INTO approvals (
          approval_id, status, tool_name, risk, source, mode, reason_encrypted,
          task_id, step_id, plan_version, args_digest, idempotency_key, args_encrypted,
          requester_identity, requested_by_principal_id, actor_principal_id, acting_for_principal_id,
          requested_at, expires_at, updated_at, attempt_count, reconciliation_status,
          platform_execution_id, timeout_ms, requires_human_approval, approval_policy
        ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'not_required', ?, ?, ?, ?)
      `).run(
        approvalId, toolName, risk, source, mode, store.encryptJson(reason),
        taskId, stepId, planVersion, digest, idempotencyKey, store.encryptJson(args),
        requesterIdentity, requestedByPrincipalId, actorPrincipalId, actingForPrincipalId,
        now, expiresAt, now, platformExecutionId, timeoutMs,
        requiresHumanApproval ? 1 : 0, approvalPolicy
      );
    } catch (error) {
      // The unique indexes are the anti-re-request rule (§4.1a) and the
      // one-live-approval-per-task rule (§4.2). A collision is a decided
      // outcome, not an internal error.
      if (String(error && error.message || "").includes("UNIQUE constraint failed")) {
        abort("duplicate_action", { idempotencyKey });
      }
      throw error;
    }

    return { approvalId, idempotencyKey, argsDigest: digest, planVersion, expiresAt };
  });
}

// ===========================================================================
// T2 — Approve
// ===========================================================================

/**
 * Marking an approval approved and making its task runnable is ONE ATOMIC ACT
 * (I2). Neither is observable without the other.
 *
 * A zero-row second statement is the dangerous case: committing the first alone
 * would leave an approved approval attached to a task that never becomes
 * runnable — an authorization that can never be consumed and never expires,
 * because expiry only applies to `pending`.
 */
function approve({ approvalId, approverIdentity, approverPrincipalId = null, now = store.nowIso() }) {
  if (!approverIdentity) return { ok: false, code: "approver_identity_required" };
  if (approverPrincipalId) {
    const approver = identity.getPrincipal(approverPrincipalId);
    if (!approver) return { ok: false, code: "principal-not-found" };
    if (!approver.enabled) return { ok: false, code: "principal-disabled" };
    if (approver.principal_type !== "human") return { ok: false, code: "human_approval_required" };
    const grant = authorization.authorize({ principalId: approverPrincipalId, permission: "approvals.grant" });
    if (!grant.ok) return { ok: false, code: grant.code };
  }

  return tx(db => {
    const approval = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId);
    if (!approval) abort("approval_not_found");
    if (!approval.task_id) abort("not_task_originated");
    if (approverPrincipalId && Number(approval.requires_human_approval) === 1) {
      if ([approval.requested_by_principal_id, approval.actor_principal_id].includes(approverPrincipalId)) {
        abort("self_approval_denied");
      }
    }

    const first = db.prepare(`
      UPDATE approvals
         SET status = 'approved', approver_identity = ?, approved_by_principal_id = ?, decided_at = ?, updated_at = ?
       WHERE approval_id = ? AND status = 'pending' AND expires_at > ? AND ${BOUND}
    `).run(approverIdentity, approverPrincipalId || null, now, now, approvalId, now, approval.task_id);
    // Concurrently denied, expired, already approved — or not the approval this
    // task is currently bound to. The operator-facing meaning differs from the
    // checkpoint failure below, so the two are reported separately.
    expectOneRow(first, "approval_not_pending");

    const second = db.prepare(`
      UPDATE task_checkpoints SET state = 'runnable', updated_at = ?
       WHERE task_id = ? AND state = 'waiting_for_approval'
    `).run(now, approval.task_id);
    expectOneRow(second, "task_not_waiting");

    return { taskId: approval.task_id, approvalId };
  });
}

// ===========================================================================
// T3 — Claim
// ===========================================================================

/**
 * Two modes, distinguished by DURABLE STATE rather than the caller's intent:
 *
 *   ACTION claim — the checkpoint has a live binding and no recorded outcome
 *                  for `next_step_id`. Transitions the bound approval to
 *                  `executing`.
 *   RESUME claim — the binding was cleared by T5/T6/T7/T10, or an outcome
 *                  already exists. Touches NO approval at all.
 *
 * Conflating them strands every non-approval wake path: T5, T6, T7 and T10 all
 * terminalise the approval and clear the binding *before* setting the
 * checkpoint runnable, so a task woken by denial or orphan recovery has no live
 * approval to transition (I17).
 *
 * Returns `pre_claim_status` for action claims — the AUTHORITATIVE
 * DISCRIMINATOR for the three action cases (I20):
 *   `approved`          → initial claim, dispatch normally, NO risk gate
 *   `executing`         → stale/crashed reclaim, APPLY the risk gate
 *   `retry_authorized`  → human-authorized redispatch, dispatch exactly once
 */
function claim({ taskId, claimedBy, now = store.nowIso() }) {
  if (!claimedBy) return { ok: false, code: "claimant_required" };

  return tx(db => {
    const checkpoint = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);
    if (!checkpoint) abort("checkpoint_not_found");

    const isInitial = checkpoint.state === "runnable";
    const isStaleReclaim = checkpoint.state === "running"
      && checkpoint.lease_expires_at != null
      && checkpoint.lease_expires_at < now;
    if (!isInitial && !isStaleReclaim) abort("not_claimable", { state: checkpoint.state });

    // Mode is decided from the binding, not the approval's status (§2).
    const recorded = checkpoint.next_step_id
      ? db.prepare("SELECT * FROM task_step_results WHERE task_id = ? AND step_id = ? AND plan_version = ?")
          .get(taskId, checkpoint.next_step_id, checkpoint.plan_version)
      : null;

    let mode;
    let boundApproval = null;
    if (checkpoint.current_approval_id) {
      boundApproval = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(checkpoint.current_approval_id);
      if (!recorded) {
        mode = "action";
      } else {
        // §5/T3: a recorded outcome alongside a LIVE approval is an integrity
        // failure, not a resume. Clearing the binding here would orphan a valid
        // authorization and leave it occupying the task's live-approval slot
        // (I23). This combination should be unreachable; observing it means an
        // atomicity invariant has already been violated.
        if (!boundApproval) {
          abort("bound_approval_missing");
        }
        if (vocab.LIVE_APPROVAL_STATUSES.includes(boundApproval.status)) {
          abort("live_approval_with_recorded_outcome", null, {
            approvalId: boundApproval.approval_id,
            eventType: "integrity_failure",
            reconciliationStatus: "manual_review",
            reasonCode: "integrity_failure",
            reasonDetail: `recorded outcome for step ${checkpoint.next_step_id} coexists with live approval status ${boundApproval.status}`,
            recoveryExecutorId: claimedBy,
          });
        }
        const agrees = recorded.approval_id === checkpoint.current_approval_id
          && recorded.args_digest === checkpoint.current_args_digest
          && recorded.idempotency_key === checkpoint.current_idempotency_key;
        if (!agrees) {
          abort("ledger_binding_disagreement", null, {
            approvalId: boundApproval.approval_id,
            eventType: "integrity_failure",
            reconciliationStatus: "manual_review",
            reasonCode: "integrity_failure",
            reasonDetail: `ledger row for step ${checkpoint.next_step_id} disagrees with the checkpoint binding`,
            recoveryExecutorId: claimedBy,
          });
        }
        // Terminal and consistent: a wake path committed the approval half and
        // did not reach the binding clear. Accept, resume, and clear it.
        mode = "resume";
      }
    } else {
      mode = "resume";
    }

    const leaseUntil = store.leaseExpiresAt(Date.parse(now) || Date.now());
    let claimInfo;
    if (isStaleReclaim) {
      // I25: capture the PRIOR attempt's identity before overwriting it. These
      // are the identifiers of the attempt that may have executed; T9's event
      // must name it, not the runner that discovered the ambiguity. Written
      // durably so a second crash does not lose them.
      claimInfo = db.prepare(`
        UPDATE task_checkpoints
           SET state = 'running', claimed_by = ?, lease_expires_at = ?,
               attempt_count = attempt_count + 1,
               claim_epoch = claim_epoch + 1,
               prior_operation_id = (SELECT operation_id FROM approvals WHERE approval_id = current_approval_id),
               prior_claimed_by = claimed_by,
               prior_claim_epoch = claim_epoch,
               prior_attempt_count = attempt_count,
               updated_at = ?
         WHERE task_id = ? AND state = 'running'
           AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
      `).run(claimedBy, leaseUntil, now, taskId, now);
    } else {
      claimInfo = db.prepare(`
        UPDATE task_checkpoints
           SET state = 'running', claimed_by = ?, lease_expires_at = ?,
               attempt_count = attempt_count + 1,
               claim_epoch = claim_epoch + 1,
               prior_operation_id = NULL, prior_claimed_by = NULL,
               prior_claim_epoch = NULL, prior_attempt_count = NULL,
               updated_at = ?
         WHERE task_id = ? AND state = 'runnable'
      `).run(claimedBy, leaseUntil, now, taskId);
    }
    // Another worker won, or the task is no longer claimable.
    expectOneRow(claimInfo, "claim_lost");

    const claimed = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);

    if (mode === "resume") {
      return {
        mode: "resume",
        taskId,
        claimEpoch: claimed.claim_epoch,
        claimedBy,
        leaseExpiresAt: leaseUntil,
        checkpoint: claimed,
        stepId: claimed.next_step_id,
        recorded: recorded || null,
      };
    }

    // --- action claim -----------------------------------------------------
    if (!boundApproval) abort("bound_approval_missing");

    const preClaimStatus = boundApproval.status;
    // §6 Stage 1: cheap, indexed claim predicates. A task failing these is
    // never claimed at all.
    if (!["approved", "executing", "retry_authorized"].includes(preClaimStatus)) {
      abort("approval_not_dispatchable", { status: preClaimStatus });
    }
    if (boundApproval.task_id !== taskId) abort("approval_task_mismatch");

    if (Number(boundApproval.attempt_count || 0) >= store.getMaxActionAttempts()) {
      // Bounds pathological looping independently of the checkpoint's counter —
      // but it must TERMINALISE, not roll back.
      //
      // Aborting here left the checkpoint `running` with an expired lease and
      // the approval `executing`. No sweeper pass selects that combination:
      // expiry only looks at `pending`/`retry_authorized`, and orphan detection
      // only at `waiting_for_approval`/`runnable`. The task was therefore
      // reclaimed and refused forever, and its `executing` approval occupied
      // `idx_approvals_one_live_per_task` permanently, so the task could never
      // request another authorization either. That is a violation of I11 and
      // I17 produced by the very guard meant to bound the loop.
      //
      // The checkpoint claim above has already committed this runner's epoch,
      // so the unwind below is fenced exactly like any other runner write.
      const terminalised = db.prepare(`
        UPDATE approvals
           SET status = 'failed', error_code = 'attempt_limit_exceeded',
               terminalized_by = ?, terminalized_at = ?, updated_at = ?
         WHERE approval_id = ? AND status = ? AND ${BOUND}
      `).run(claimedBy, now, now, boundApproval.approval_id, preClaimStatusOf(boundApproval), taskId);
      expectOneRow(terminalised, "approval_status_changed");

      insertStepResult(db, {
        task_id: taskId,
        step_id: boundApproval.step_id,
        plan_version: boundApproval.plan_version,
        args_digest: boundApproval.args_digest,
        idempotency_key: boundApproval.idempotency_key,
        status: "refused",
        result_encrypted: null,
        result_digest: null,
        outcome_code: "attempt_limit_exceeded",
        error_detail_encrypted: null,
        approval_id: boundApproval.approval_id,
        recorded_at: now,
      });

      const failed = db.prepare(`
        UPDATE task_checkpoints
           SET state = 'failed', claimed_by = NULL, lease_expires_at = NULL, updated_at = ?,
               ${CLEAR_BINDING_SQL}
         WHERE task_id = ? AND claim_epoch = ? AND claimed_by = ? AND state = 'running'
      `).run(now, taskId, claimed.claim_epoch, claimedBy);
      expectOneRow(failed, "claim_superseded");

      store.recordRecoveryEvent({
        approvalId: boundApproval.approval_id,
        eventType: "attempt_limit_exceeded",
        reconciliationStatus: "manual_review",
        reasonCode: "attempt_limit_exceeded",
        reasonDetail: `action reclaimed ${boundApproval.attempt_count} times without producing an outcome; task failed`,
        recoveryExecutorId: claimedBy,
        at: now,
      });

      return { mode: "terminalised", taskId, code: "attempt_limit_exceeded", checkpointState: "failed" };
    }

    const operationId = store.newOperationId();
    const actionInfo = db.prepare(`
      UPDATE approvals
         SET status = 'executing', operation_id = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE approval_id = ? AND status = ? AND ${BOUND}
         AND status IN ('approved', 'executing', 'retry_authorized')
    `).run(operationId, now, boundApproval.approval_id, preClaimStatus, taskId);
    expectOneRow(actionInfo, "approval_claim_lost");

    return {
      mode: "action",
      taskId,
      claimEpoch: claimed.claim_epoch,
      claimedBy,
      leaseExpiresAt: leaseUntil,
      checkpoint: claimed,
      approval: db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(boundApproval.approval_id),
      approvalId: boundApproval.approval_id,
      preClaimStatus,
      operationId,
      stepId: claimed.current_step_id,
      // I20: the risk gate applies ONLY where ambiguity actually exists. A step
      // being dispatched for the first time under a fresh authorization
      // (`approved`) or an explicitly human-authorized redispatch
      // (`retry_authorized`) is never gated — nothing has run, so there is
      // nothing ambiguous. Only a reclaim of an action a previous claimant
      // already held (`executing`) is.
      riskGated: preClaimStatus === "executing",
      requiresReconciliation: preClaimStatus === "executing" && needsManualReconciliation(boundApproval.risk),
    };
  });
}

// ===========================================================================
// §6 Stage 2 — post-claim verification
// ===========================================================================

/**
 * Everything requiring decryption or plan traversal, which cannot be expressed
 * in SQL. The approval is `executing` and the checkpoint is `running` while
 * these run, so a failure must UNWIND the claim through T6 rather than simply
 * decline it.
 *
 * The ledger check is a SHORT-CIRCUIT, not a refusal, and is evaluated FIRST: a
 * step whose outcome is already recorded needs no re-verification because it
 * will not be dispatched.
 *
 * `args_digest` is recomputed from the PERSISTED PLAN rather than trusted from
 * the stored value, so an approval can only execute the arguments a human
 * actually saw (I5).
 */
function verifyClaim({ claimResult, taskCancelled = false, now = store.nowIso() }) {
  const { checkpoint, approval } = claimResult;

  const recorded = store.getStepResult(checkpoint.task_id, checkpoint.current_step_id, checkpoint.plan_version);
  if (recorded) return { ok: true, shortCircuit: true, recorded };

  if (taskCancelled) return { ok: false, outcome: "task_cancelled" };
  if (!(approval.expires_at > now)) return { ok: false, outcome: "approval_expired" };
  if (approval.status !== "executing") return { ok: false, outcome: "approval_cancelled" };
  if (approval.plan_version !== checkpoint.plan_version) return { ok: false, outcome: "plan_superseded" };

  let plan;
  try {
    plan = store.decryptJson(checkpoint.plan_encrypted);
  } catch {
    // Deliberately not surfacing the underlying error: §4.4 forbids a captured
    // exception message from reaching a persisted column, and this outcome
    // flows into `error_detail_encrypted`.
    return { ok: false, outcome: "checkpoint_corrupt" };
  }
  if (!plan) return { ok: false, outcome: "checkpoint_corrupt" };
  if (keys.planDigest(plan) !== checkpoint.plan_digest) return { ok: false, outcome: "checkpoint_corrupt" };

  const step = (plan.steps || []).find(s => s && s.id === approval.step_id);
  if (!step) return { ok: false, outcome: "step_not_in_plan" };

  // The TOOL is part of the authorized action identity (§3) and must be
  // reconciled too. Verifying only the arguments would let a plan whose step
  // carries the approved arguments under a DIFFERENT tool execute under a
  // human's authorization for the original one.
  if (step.tool !== approval.tool_name) return { ok: false, outcome: "arguments_altered" };

  const recomputed = keys.argsDigest(step.arguments || {});
  if (recomputed !== approval.args_digest) return { ok: false, outcome: "arguments_altered" };

  // A NULL payload is not an empty payload. Without this, `decryptJson` returns
  // null, `argsDigest(null || {})` equals `argsDigest({})`, and an approval
  // whose payload had been discarded or never written would pass the
  // authentication below whenever its real arguments happened to be `{}`.
  // Reject the missing case outright rather than letting a default stand in for
  // authorization.
  if (approval.args_encrypted == null) return { ok: false, outcome: "checkpoint_corrupt" };

  let args;
  try {
    args = store.decryptJson(approval.args_encrypted);
  } catch {
    return { ok: false, outcome: "checkpoint_corrupt" };
  }
  if (args == null) return { ok: false, outcome: "checkpoint_corrupt" };

  // AUTHENTICATE THE PAYLOAD THAT IS ACTUALLY EXECUTED.
  //
  // The check above proves the persisted PLAN matches the digest; it proves
  // nothing about `args_encrypted`, which is a separate copy and is what gets
  // dispatched. Without this, anyone able to write one column could swap in
  // ciphertext they legitimately created elsewhere and have it executed under
  // someone else's approval, with the benign digest still recorded in the
  // ledger afterwards.
  //
  // This is the same integrity check the legacy path has always performed in
  // `decryptApprovalArgs` (`tools-legacy.js`), and that `recoverOrphan` and the
  // orphan sweep both apply. Omitting it here — the one place it is
  // load-bearing — made I5 unenforced.
  if (keys.argsDigest(args || {}) !== approval.args_digest) {
    return { ok: false, outcome: "arguments_altered" };
  }

  return { ok: true, shortCircuit: false, plan, step, args };
}

// ===========================================================================
// T4A / T4R — Advance
// ===========================================================================

/**
 * T4A — record a newly executed action.
 *
 * All three statements are fenced by the claim. A runner whose lease expired
 * and whose task was reclaimed matches zero rows, rolls back, and MUST DISCARD
 * ITS RESULT rather than overwrite the current claimant's work (I16).
 *
 * The approval UPDATE runs BEFORE the binding is cleared, because it resolves
 * `<bound>` through `current_approval_id`.
 */
function recordActionResult({
  taskId, claimEpoch, claimedBy, approvalId, stepId, planVersion,
  argsDigest, idempotencyKey, result, resultDigest,
  nextStepId, evidence, evidenceChars, successfulToolEvidence,
  now = store.nowIso(),
}) {
  return tx(db => {
    insertStepResult(db, {
      task_id: taskId,
      step_id: stepId,
      plan_version: planVersion,
      args_digest: argsDigest,
      idempotency_key: idempotencyKey,
      status: "completed",
      result_encrypted: store.encryptJson(result),
      result_digest: resultDigest || null,
      outcome_code: null,
      error_detail_encrypted: null,
      approval_id: approvalId,
      recorded_at: now,
    });

    const approvalInfo = db.prepare(`
      UPDATE approvals
         SET status = 'completed', result_digest = ?, completed_at = ?, updated_at = ?
       WHERE approval_id = ? AND status = 'executing' AND ${BOUND}
    `).run(resultDigest || null, now, now, approvalId, taskId);
    expectOneRow(approvalInfo, "approval_not_executing");

    const checkpointInfo = db.prepare(`
      UPDATE task_checkpoints
         SET next_step_id = ?, evidence_encrypted = ?, evidence_chars = ?,
             successful_tool_evidence = ?, state = 'running', updated_at = ?,
             ${CLEAR_BINDING_SQL}
       WHERE task_id = ? AND claim_epoch = ? AND claimed_by = ? AND state = 'running'
    `).run(
      nextStepId || null, store.encryptJson(evidence), evidenceChars,
      successfulToolEvidence, now, taskId, claimEpoch, claimedBy
    );
    expectOneRow(checkpointInfo, "claim_superseded");

    return { taskId, approvalId };
  });
}

/**
 * T4R — consume an existing ledger outcome after a resume claim.
 *
 * Performs NO result INSERT and NO approval UPDATE (I21): the outcome is
 * already durable and the approval, if any, is already terminal. Revision 5's
 * single T4 unconditionally inserted `status='completed'`, so a resume waking
 * on a refusal inserted a conflicting row and was treated as an integrity
 * failure.
 */
function consumeRecordedOutcome({
  taskId, claimEpoch, claimedBy, stepId, planVersion,
  nextStepId, evidence, evidenceChars, successfulToolEvidence,
  now = store.nowIso(),
}) {
  return tx(db => {
    const recorded = db.prepare(
      "SELECT * FROM task_step_results WHERE task_id = ? AND step_id = ? AND plan_version = ?"
    ).get(taskId, stepId, planVersion);
    // Absent → this is not a resumable state. Route to T7, the path for a
    // checkpoint whose action cannot be resolved.
    if (!recorded) abort("no_recorded_outcome");

    const checkpoint = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);
    if (!checkpoint) abort("checkpoint_not_found");
    // Never advance on a result belonging to a different action.
    if (checkpoint.current_idempotency_key && recorded.idempotency_key !== checkpoint.current_idempotency_key) {
      abort("ledger_binding_disagreement", null, {
        approvalId: recorded.approval_id || checkpoint.current_approval_id || taskId,
        eventType: "integrity_failure",
        reconciliationStatus: "manual_review",
        reasonCode: "integrity_failure",
        reasonDetail: `ledger idempotency key does not match the checkpoint binding for step ${stepId}`,
        recoveryExecutorId: claimedBy,
      });
    }
    if (checkpoint.current_args_digest && recorded.args_digest !== checkpoint.current_args_digest) {
      abort("ledger_binding_disagreement", null, {
        approvalId: recorded.approval_id || checkpoint.current_approval_id || taskId,
        eventType: "integrity_failure",
        reconciliationStatus: "manual_review",
        reasonCode: "integrity_failure",
        reasonDetail: `ledger args digest does not match the checkpoint binding for step ${stepId}`,
        recoveryExecutorId: claimedBy,
      });
    }

    // The binding is cleared unconditionally even though it is usually already
    // NULL: a resume triggered by an existing result alongside a stale binding
    // must not let that binding survive the advance (I18).
    const info = db.prepare(`
      UPDATE task_checkpoints
         SET next_step_id = ?, evidence_encrypted = ?, evidence_chars = ?,
             successful_tool_evidence = ?, state = 'running', updated_at = ?,
             ${CLEAR_BINDING_SQL}
       WHERE task_id = ? AND claim_epoch = ? AND claimed_by = ? AND state = 'running'
    `).run(
      nextStepId || null, store.encryptJson(evidence), evidenceChars,
      successfulToolEvidence, now, taskId, claimEpoch, claimedBy
    );
    expectOneRow(info, "claim_superseded");

    let resultValue = null;
    if (recorded.result_encrypted) {
      try { resultValue = store.decryptJson(recorded.result_encrypted); } catch { resultValue = null; }
    }
    return { taskId, recorded, result: resultValue };
  });
}

// ===========================================================================
// T5 — Wake
// ===========================================================================

/**
 * The atomic path for a terminal decision taken while the task is parked or
 * runnable but unclaimed: denial, expiry, cancellation, supersession (§7.1).
 *
 * Persisting the structured step outcome and making the checkpoint runnable are
 * ONE transaction (I10). Doing only the first strands the task in
 * `waiting_for_approval` forever; doing only the second resumes a task that
 * cannot tell why.
 *
 * EXACT PAIRS, not independent sets. T2 moves both rows together, so approval
 * status and checkpoint state are correlated; listing them separately would
 * accept combinations that cannot legitimately occur and paper over a real
 * inconsistency.
 */
const WAKE_TRIGGERS = Object.freeze({
  deny: {
    permitted: ["pending"],
    status: "denied",
    outcome: "approval_denied",
  },
  expire: {
    permitted: ["pending", "retry_authorized"],
    status: "expired",
    outcome: "approval_expired",
  },
  cancel: {
    permitted: ["pending", "approved", "retry_authorized"],
    status: "cancelled",
    outcome: "approval_cancelled",
  },
  supersede: {
    permitted: ["pending", "approved", "retry_authorized"],
    status: "superseded",
    outcome: "plan_superseded",
  },
});

// §7.1: the checkpoint state that must accompany each observed approval status.
const PAIRED_CHECKPOINT_STATE = Object.freeze({
  pending: "waiting_for_approval",
  approved: "runnable",
  retry_authorized: "runnable",
});

function wake({ approvalId, trigger, actor = "system", now = store.nowIso() }) {
  const spec = WAKE_TRIGGERS[trigger];
  if (!spec) return { ok: false, code: "unknown_trigger" };

  return tx(db => {
    const approval = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId);
    if (!approval) abort("approval_not_found");
    if (!approval.task_id) abort("not_task_originated");

    // Authoritative re-read INSIDE the transaction. The pair below is derived
    // from the OBSERVED status, never from the caller's belief.
    const bound = db.prepare("SELECT current_approval_id, state FROM task_checkpoints WHERE task_id = ?").get(approval.task_id);
    if (!bound || bound.current_approval_id !== approvalId) {
      // Not the bound approval, or it is gone: hand off to T7 (§7.3).
      abort("not_bound", { taskId: approval.task_id });
    }

    const observed = approval.status;
    if (!spec.permitted.includes(observed)) {
      abort("status_not_permitted_for_trigger", { observed, trigger });
    }
    // Cancelling an approval already `executing` is refused here: the step is
    // in flight under a live epoch, and T5's `runnable` transition would
    // corrupt that claim. Task cancellation is the correct control at that
    // point, observed by the runner in Stage 2 and unwound through T6.
    const pairedState = PAIRED_CHECKPOINT_STATE[observed];
    if (!pairedState) abort("no_paired_state", { observed });

    const approvalInfo = db.prepare(`
      UPDATE approvals
         SET status = ?, terminalized_by = ?, terminalized_at = ?, error_code = ?, updated_at = ?
       WHERE approval_id = ? AND status = ? AND ${BOUND}
    `).run(spec.status, actor, now, spec.outcome, now, approvalId, observed, approval.task_id);
    expectOneRow(approvalInfo, "approval_status_changed");

    insertStepResult(db, {
      task_id: approval.task_id,
      step_id: approval.step_id,
      plan_version: approval.plan_version,
      args_digest: approval.args_digest,
      idempotency_key: approval.idempotency_key,
      status: "refused",
      result_encrypted: null,
      result_digest: null,
      outcome_code: spec.outcome,
      error_detail_encrypted: null,
      approval_id: approvalId,
      recorded_at: now,
    });

    const checkpointInfo = db.prepare(`
      UPDATE task_checkpoints
         SET state = 'runnable', updated_at = ?, ${CLEAR_BINDING_SQL}
       WHERE task_id = ? AND state = ?
    `).run(now, approval.task_id, pairedState);
    expectOneRow(checkpointInfo, "checkpoint_state_mismatch", { expected: pairedState });

    return { taskId: approval.task_id, approvalId, outcome: spec.outcome, status: spec.status };
  });
}

/**
 * Task cancellation is distinct from approval cancellation: it TERMINALISES the
 * task rather than waking it, and terminalises any live approval bound to it in
 * the same transaction (§7.1).
 */
function cancelTask({ taskId, actor = "system", now = store.nowIso() }) {
  return tx(db => {
    const checkpoint = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);
    if (!checkpoint) abort("checkpoint_not_found");
    if (vocab.TERMINAL_CHECKPOINT_STATES.includes(checkpoint.state)) abort("already_terminal", { state: checkpoint.state });

    if (checkpoint.current_approval_id) {
      const live = db.prepare(
        `SELECT * FROM approvals WHERE approval_id = ? AND status IN (${store.LIVE_STATUS_SQL})`
      ).get(checkpoint.current_approval_id);
      if (live) {
        const info = db.prepare(`
          UPDATE approvals
             SET status = 'cancelled', terminalized_by = ?, terminalized_at = ?,
                 error_code = 'task_cancelled', updated_at = ?
           WHERE approval_id = ? AND status = ? AND ${BOUND}
        `).run(actor, now, now, live.approval_id, live.status, taskId);
        expectOneRow(info, "approval_status_changed");
      }
    }

    const info = db.prepare(`
      UPDATE task_checkpoints
         SET state = 'cancelled', claimed_by = NULL, lease_expires_at = NULL,
             updated_at = ?, ${CLEAR_BINDING_SQL}
       WHERE task_id = ? AND state = ?
    `).run(now, taskId, checkpoint.state);
    expectOneRow(info, "checkpoint_state_changed");

    return { taskId };
  });
}

// ===========================================================================
// T6 — Post-claim refusal
// ===========================================================================

/**
 * A Stage-2 failure leaves the approval `executing` and the checkpoint
 * `running` under this runner's epoch. Both must be unwound atomically, or the
 * task is stranded mid-claim with an approval that can never be consumed
 * (§6.1).
 *
 * The whole binding is cleared, so the task wakes via a RESUME claim — which is
 * exactly why that mode exists.
 */
function refusePostClaim({
  taskId, claimEpoch, claimedBy, approvalId, outcomeCode,
  actor = "system", detail = null, now = store.nowIso(),
}) {
  vocab.assertOutcomeCode(outcomeCode);
  const approvalStatus = vocab.REFUSAL_STATUS_BY_OUTCOME[outcomeCode];
  if (!approvalStatus) return { ok: false, code: "unsupported_refusal_outcome" };

  // `task_cancelled` terminalises the task; `checkpoint_corrupt` fails it —
  // the plan cannot be trusted, so there is nothing to resume into.
  const checkpointState = outcomeCode === "task_cancelled"
    ? "cancelled"
    : outcomeCode === "checkpoint_corrupt" ? "failed" : "runnable";

  return tx(db => {
    const approval = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId);
    if (!approval) abort("approval_not_found");

    const approvalInfo = db.prepare(`
      UPDATE approvals
         SET status = ?, error_code = ?, error_detail_encrypted = ?,
             terminalized_by = ?, terminalized_at = ?, updated_at = ?
       WHERE approval_id = ? AND status = 'executing' AND ${BOUND}
    `).run(
      approvalStatus, outcomeCode, store.encryptDetail(detail),
      actor, now, now, approvalId, taskId
    );
    // `approver_identity` and `decided_at` are untouched: the original
    // authorization stands as a historical fact (§4.1).
    expectOneRow(approvalInfo, "approval_not_executing");

    insertStepResult(db, {
      task_id: taskId,
      step_id: approval.step_id,
      plan_version: approval.plan_version,
      args_digest: approval.args_digest,
      idempotency_key: approval.idempotency_key,
      status: "refused",
      result_encrypted: null,
      result_digest: null,
      outcome_code: outcomeCode,
      error_detail_encrypted: store.encryptDetail(detail),
      approval_id: approvalId,
      recorded_at: now,
    });

    const checkpointInfo = db.prepare(`
      UPDATE task_checkpoints
         SET state = ?, claimed_by = NULL, lease_expires_at = NULL, updated_at = ?,
             ${CLEAR_BINDING_SQL}
       WHERE task_id = ? AND claim_epoch = ? AND claimed_by = ? AND state = 'running'
    `).run(checkpointState, now, taskId, claimEpoch, claimedBy);
    expectOneRow(checkpointInfo, "claim_superseded");

    return { taskId, approvalId, outcome: outcomeCode, checkpointState };
  });
}

// ===========================================================================
// T7 — Orphan recovery
// ===========================================================================

/**
 * The path for a checkpoint whose approval is MISSING or UNREADABLE, which T5
 * cannot repair — T5's first statement is an approval UPDATE that matches zero
 * rows and rolls back, so such a task would be swept repeatedly, fail
 * identically every time, and never wake (I14).
 *
 * The result row is constructed ENTIRELY FROM THE CHECKPOINT. That is why the
 * four `current_*` binding fields exist: reading them from the approval — as
 * every other transaction does — is exactly what is impossible here.
 *
 * Deliberately NOT disguised as expiry: calling a missing approval "expired"
 * would record a false operational history.
 */
function recoverOrphan({ taskId, actor = "system", now = store.nowIso() }) {
  return tx(db => {
    const checkpoint = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);
    if (!checkpoint) abort("checkpoint_not_found");
    if (!["waiting_for_approval", "runnable"].includes(checkpoint.state)) {
      abort("not_orphan_recoverable", { state: checkpoint.state });
    }

    // A checkpoint whose binding fields are themselves NULL cannot construct a
    // result row and is unrecoverable: fail it rather than wake it into a plan
    // step whose identity is unknown.
    if (!checkpoint.current_step_id || !checkpoint.current_args_digest || !checkpoint.current_idempotency_key) {
      const failed = db.prepare(`
        UPDATE task_checkpoints
           SET state = 'failed', updated_at = ?, ${CLEAR_BINDING_SQL}
         WHERE task_id = ? AND state = ?
      `).run(now, taskId, checkpoint.state);
      expectOneRow(failed, "checkpoint_state_changed");
      store.recordRecoveryEvent({
        approvalId: checkpoint.current_approval_id || taskId,
        eventType: "orphaned_checkpoint",
        reconciliationStatus: "manual_review",
        reasonCode: "checkpoint_unrecoverable",
        reasonDetail: `checkpoint ${taskId} has an incomplete binding and cannot construct a step outcome`,
        recoveryExecutorId: actor,
      });
      return { taskId, branch: "unrecoverable", checkpointState: "failed" };
    }

    const approval = checkpoint.current_approval_id
      ? db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(checkpoint.current_approval_id)
      : null;

    // Three branches, distinguished BEFORE anything is written.
    let branch;
    if (!approval) {
      branch = "missing";
    } else if (vocab.TERMINAL_APPROVAL_STATUSES.includes(approval.status)) {
      branch = "half_woken";
    } else {
      let readable = true;
      try {
        const args = store.decryptJson(approval.args_encrypted);
        if (keys.argsDigest(args || {}) !== approval.args_digest) readable = false;
      } catch {
        readable = false;
      }
      if (readable) abort("approval_is_live_and_readable", { status: approval.status });
      branch = "corrupt";
    }

    insertStepResult(db, {
      task_id: checkpoint.task_id,
      step_id: checkpoint.current_step_id,
      plan_version: checkpoint.plan_version,
      args_digest: checkpoint.current_args_digest,
      idempotency_key: checkpoint.current_idempotency_key,
      status: "refused",
      result_encrypted: null,
      result_digest: null,
      outcome_code: "approval_missing_or_corrupt",
      error_detail_encrypted: null,
      approval_id: checkpoint.current_approval_id,
      recorded_at: now,
    });

    if (branch === "corrupt") {
      // A row that cannot be read is still a row, and every live status is in
      // `idx_approvals_one_live_per_task` — leaving it live would permanently
      // block every future approval for this task, converting a recoverable
      // corruption into a task that can never request authorization again.
      // `quarantined` is deliberately outside the live set so the slot is
      // released, while the row is retained for audit rather than deleted.
      const info = db.prepare(`
        UPDATE approvals
           SET status = 'quarantined', error_code = 'payload_unreadable',
               terminalized_by = ?, terminalized_at = ?, updated_at = ?
         WHERE approval_id = ? AND task_id = ? AND status IN (${store.LIVE_STATUS_SQL})
      `).run(actor, now, now, checkpoint.current_approval_id, taskId);
      expectOneRow(info, "quarantine_failed");
    }

    const checkpointInfo = db.prepare(`
      UPDATE task_checkpoints
         SET state = 'runnable', updated_at = ?, ${CLEAR_BINDING_SQL}
       WHERE task_id = ? AND state IN ('waiting_for_approval', 'runnable')
    `).run(now, taskId);
    expectOneRow(checkpointInfo, "checkpoint_state_changed");

    store.recordRecoveryEvent({
      approvalId: checkpoint.current_approval_id || taskId,
      eventType: "orphaned_checkpoint",
      reconciliationStatus: "manual_review",
      reasonCode: "orphaned_checkpoint",
      reasonDetail: `orphan recovery branch=${branch} for step ${checkpoint.current_step_id}`,
      recoveryExecutorId: actor,
    });

    return { taskId, branch, outcome: "approval_missing_or_corrupt" };
  });
}

// ===========================================================================
// T8 — Renew lease
// ===========================================================================

/**
 * The whole recovery design rests on leases expiring only when a claimant has
 * genuinely stopped, so renewal is fenced by the same epoch as every other
 * write (I16).
 *
 * A zero-row renewal means the runner was SUPERSEDED — reclaimed after a stall,
 * or the task was cancelled — and it must ABANDON THE STEP IMMEDIATELY rather
 * than continue toward a T4 that will also fail. Renewal is the earliest point
 * a stalled worker can discover it has lost the claim; the interval bounds how
 * long it can keep working before finding out. This is not an error to retry.
 */
function renewLease({ taskId, claimEpoch, claimedBy, now = store.nowIso() }) {
  store.ensureApprovalContinuationSchema();
  const leaseUntil = store.leaseExpiresAt(Date.parse(now) || Date.now());
  const info = store.getDb().prepare(`
    UPDATE task_checkpoints
       SET lease_expires_at = ?, updated_at = ?
     WHERE task_id = ? AND claim_epoch = ? AND claimed_by = ? AND state = 'running'
  `).run(leaseUntil, now, taskId, claimEpoch, claimedBy);
  if (info.changes !== 1) return { ok: false, code: "claim_superseded" };
  return { ok: true, leaseExpiresAt: leaseUntil };
}

// ===========================================================================
// T9 — Enter reconciliation
// ===========================================================================

/**
 * The atomic transition when the risk gate refuses to redispatch an ambiguous
 * step (§8.1). The task cannot stay `running` (nothing holds it) and must not
 * go back to `runnable` (the next sweep would re-claim and refuse again,
 * forever), so `reconciling` is the durable, inert parking place.
 *
 * NO `task_step_results` row is written: whether the step succeeded is
 * precisely what is unknown, and recording either outcome would be a
 * fabrication. The ABSENCE of the row is the record that the question is open
 * (I15).
 *
 * The recovery event names the PRIOR attempt — the one that may have executed —
 * from the checkpoint's `prior_*` columns, not the runner that discovered the
 * ambiguity. Naming the recovery claimant would point an investigating operator
 * at a runner that provably did not dispatch anything (I25).
 */
function enterReconciliation({ taskId, claimEpoch, recoveryExecutorId, approvalId, now = store.nowIso() }) {
  return tx(db => {
    const checkpoint = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);
    if (!checkpoint) abort("checkpoint_not_found");

    const checkpointInfo = db.prepare(`
      UPDATE task_checkpoints
         SET state = 'reconciling', claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE task_id = ? AND claim_epoch = ? AND state = 'running'
    `).run(now, taskId, claimEpoch);
    expectOneRow(checkpointInfo, "claim_superseded");

    const approvalInfo = db.prepare(`
      UPDATE approvals
         SET reconciliation_status = 'manual_review', status = 'reconciliation_required',
             error_code = 'ambiguous_execution', updated_at = ?
       WHERE approval_id = ? AND status = 'executing' AND ${BOUND}
    `).run(now, approvalId, taskId);
    expectOneRow(approvalInfo, "approval_not_executing");

    store.recordRecoveryEvent({
      approvalId,
      eventType: "ambiguous_execution",
      reconciliationStatus: "manual_review",
      reasonCode: "ambiguous_execution",
      reasonDetail: `ambiguous execution of step ${checkpoint.current_step_id}; prior attempt ${checkpoint.prior_operation_id || "unknown"}`,
      operationId: checkpoint.prior_operation_id,
      executorId: checkpoint.prior_claimed_by,
      recoveryExecutorId,
      priorClaimEpoch: checkpoint.prior_claim_epoch,
      priorAttemptCount: checkpoint.prior_attempt_count,
      at: now,
    });

    return { taskId, approvalId, checkpointState: "reconciling" };
  });
}

// ===========================================================================
// T10 — Resolve reconciliation
// ===========================================================================

/**
 * Exactly four decisions are permitted. Each records an outcome and moves the
 * task; none leaves it in `reconciling` (§8.2).
 *
 * ORDER MATTERS. Revision 4 cleared `current_approval_id` first and then
 * updated the approval through `<bound>` — which by then resolved to NULL, so
 * the approval update matched zero rows and every binding-clearing decision
 * rolled back. The approval is updated and verified THROUGH THE STILL-INTACT
 * BINDING, and the binding is cleared LAST.
 *
 * AUTHORIZATION, NOT MERELY ATTRIBUTION (I19). A reconciliation decision
 * resolves a high-risk ambiguity and must be made by an authenticated human.
 * The planner, the task runner, a tool, or any automated actor must not resolve
 * an ambiguity — least of all its own. An implementation that cannot enforce a
 * permission must FAIL CLOSED and leave the task in `reconciling` rather than
 * accept an unauthorized resolution.
 */
const RECONCILIATION_SPEC_LEGACY = Object.freeze({
  confirm_executed: {
    approvalStatus: "completed",
    stepStatus: "completed",
    outcome: "reconciled_executed",
    checkpointState: "runnable",
    clearBinding: true,
    recordStep: true,
    refreshExpiry: false,
  },
  confirm_not_executed: {
    // Must leave a DISPATCHABLE authorization. A terminal approval would make
    // the retained binding unusable and strand the task again, because T3's
    // action claim requires approved/executing/retry_authorized.
    approvalStatus: "retry_authorized",
    stepStatus: null,
    outcome: null,
    checkpointState: "runnable",
    clearBinding: false,
    recordStep: false,
    refreshExpiry: true,
  },
  abandon_step: {
    approvalStatus: "superseded",
    stepStatus: "refused",
    outcome: "reconciliation_abandoned",
    checkpointState: "runnable",
    clearBinding: true,
    recordStep: true,
    refreshExpiry: false,
  },
  fail_task: {
    approvalStatus: "superseded",
    stepStatus: "refused",
    outcome: "reconciliation_failed",
    checkpointState: "failed",
    clearBinding: true,
    recordStep: true,
    refreshExpiry: false,
  },
});

const AUTOMATED_ACTORS_LEGACY = new Set([
  "agent", "system", "dashboard", "brain", "planner", "runner", "recovery",
  "mcp", "internal", "approval", "test", "sweeper", "deadline", "task-runner",
  "automation", "root", "sidekick", "sidekick-agent", "service", "cron", "scheduler",
]);

// Zero-width and bidi controls. Present only to make two visually identical
// strings compare unequal, which is exactly what a denylist bypass needs.
const INVISIBLE_CHARS_LEGACY = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * `reconciled_by` must be a REAL PRINCIPAL, not a surface name. The pre-ADR
 * approval path hardcoded `reviewer` to "dashboard", which is unusable here: a
 * reconciliation attributed to "dashboard" is indistinguishable from an
 * unattributed one.
 *
 * This is a DENYLIST, which is the weaker construction, and it is used
 * deliberately: Sidekick has no permission system to bind an allowlist to yet
 * (§8.2 marks the role model provisional). Its known weakness is that an
 * unlisted automated name passes, so the checks below close the ways a
 * *deliberate* bypass would be spelled:
 *
 *  - Unicode confusables and zero-width padding are normalised away, so
 *    "ｓystem", "system​" and "ſystem" cannot slip past a name comparison.
 *  - The `unattributed:` prefix is rejected outright. `src/dashboard.js` uses
 *    `unattributed:dashboard` to mean precisely "there is no attributable
 *    human" — a marker that must never satisfy a check for one.
 *
 * The caller is still required to fail closed when it has no authenticated
 * principal; this is the second line, not the first.
 */
function isAuthorizedHumanLegacy(identity) {
  if (typeof identity !== "string") return false;
  const normalized = identity
    .normalize("NFKC")
    .replace(INVISIBLE_CHARS, "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("unattributed:")) return false;
  if (AUTOMATED_ACTORS_LEGACY.has(normalized)) return false;
  return true;
}

const RECONCILIATION_SPEC = RECONCILIATION_POLICY;
const isAuthorizedHuman = isAuthorizedHumanPolicy;

function resolveReconciliation({
  taskId, decision, reconciledBy, detail = null, now = store.nowIso(),
}) {
  vocab.assertReconciliationDecision(decision);
  const spec = RECONCILIATION_SPEC[decision];

  // Fail closed: an unauthorized or unattributable resolution leaves the task
  // in `reconciling` rather than being accepted.
  if (!isAuthorizedHuman(reconciledBy)) {
    return { ok: false, code: "reconciliation_requires_authorized_human" };
  }

  return tx(db => {
    const checkpoint = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);
    if (!checkpoint) abort("checkpoint_not_found");
    if (checkpoint.state !== "reconciling") abort("task_not_reconciling", { state: checkpoint.state });
    const approvalId = checkpoint.current_approval_id;
    if (!approvalId) abort("no_bound_approval");

    const approval = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId);
    if (!approval) abort("approval_not_found");

    const refreshedExpiry = spec.refreshExpiry
      ? store.expiresAtFrom(Date.parse(now) || Date.now())
      : approval.expires_at;

    // `approver_identity` is NOT touched: the original authorization stands.
    // These are frequently different people, and collapsing them would destroy
    // the audit trail precisely where it matters most.
    const approvalInfo = db.prepare(`
      UPDATE approvals
         SET status = ?, expires_at = ?, reconciliation_status = 'resolved',
             reconciled_by = ?, reconciled_at = ?, reconciliation_decision = ?, updated_at = ?
       WHERE approval_id = ? AND status = 'reconciliation_required' AND ${BOUND}
    `).run(
      spec.approvalStatus, refreshedExpiry, reconciledBy, now, decision, now,
      approvalId, taskId
    );
    expectOneRow(approvalInfo, "approval_not_reconciliation_required");

    if (spec.recordStep) {
      insertStepResult(db, {
        task_id: taskId,
        step_id: approval.step_id,
        plan_version: approval.plan_version,
        args_digest: approval.args_digest,
        idempotency_key: approval.idempotency_key,
        status: spec.stepStatus,
        result_encrypted: null,
        result_digest: null,
        outcome_code: spec.outcome,
        error_detail_encrypted: store.encryptDetail(detail),
        approval_id: approvalId,
        recorded_at: now,
      });
    }

    const checkpointInfo = db.prepare(`
      UPDATE task_checkpoints
         SET state = ?, updated_at = ?${spec.clearBinding ? ", " + CLEAR_BINDING_SQL : ""}
       WHERE task_id = ? AND state = 'reconciling'
    `).run(spec.checkpointState, now, taskId);
    expectOneRow(checkpointInfo, "checkpoint_state_changed");

    store.recordRecoveryEvent({
      approvalId,
      eventType: "reconciliation_resolved",
      reconciliationStatus: "resolved",
      reasonCode: "reconciliation_resolved",
      reasonDetail: `decision=${decision} by an authorized human`,
      recoveryExecutorId: reconciledBy,
      at: now,
    });

    return { taskId, approvalId, decision, checkpointState: spec.checkpointState };
  });
}

/**
 * The checkpoint's `deadline_at` is the outer bound: a task parked past its
 * deadline is failed with `timed_out`, whatever its approval says. A deadline
 * must NOT silently resolve an ambiguity — a reconciling task is failed with
 * the approval left `reconciliation_required` for audit (§8.2).
 */
function failOverdue({ taskId, now = store.nowIso() }) {
  return tx(db => {
    const checkpoint = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);
    if (!checkpoint) abort("checkpoint_not_found");
    if (!checkpoint.deadline_at || checkpoint.deadline_at >= now) abort("not_overdue");
    if (vocab.TERMINAL_CHECKPOINT_STATES.includes(checkpoint.state)) abort("already_terminal");

    const wasReconciling = checkpoint.state === "reconciling";
    const info = db.prepare(`
      UPDATE task_checkpoints
         SET state = 'timed_out', claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE task_id = ? AND state = ?
    `).run(now, taskId, checkpoint.state);
    expectOneRow(info, "checkpoint_state_changed");

    // A live approval bound to a task that has just timed out must not stay
    // live: it would keep occupying `idx_approvals_one_live_per_task` forever
    // for a task that can never consume it.
    //
    // The `reconciling` case is the deliberate exception — §8.2 requires the
    // approval to be left `reconciliation_required` for audit, because a
    // deadline must never be allowed to silently resolve an ambiguity (I15).
    if (!wasReconciling && checkpoint.current_approval_id) {
      const live = db.prepare(
        `SELECT * FROM approvals WHERE approval_id = ? AND status IN (${store.LIVE_STATUS_SQL})`
      ).get(checkpoint.current_approval_id);
      if (live) {
        const terminalised = db.prepare(`
          UPDATE approvals
             SET status = 'cancelled', error_code = 'task_deadline_exceeded',
                 terminalized_by = 'deadline', terminalized_at = ?, updated_at = ?
           WHERE approval_id = ? AND status = ?
        `).run(now, now, live.approval_id, live.status);
        expectOneRow(terminalised, "approval_status_changed");
      }
    }

    return { taskId, checkpointState: "timed_out", approvalLeftForAudit: wasReconciling };
  });
}

/**
 * Move a claimed checkpoint to a terminal state once the task itself finishes.
 * Fenced by the claim like every other runner write (I16), so a superseded
 * runner cannot terminalise a task the current claimant is still working on.
 *
 * The row is retained rather than deleted: §4.5 requires that a checkpoint is
 * never destroyed, because approvals reference it under a RESTRICT foreign key
 * and an approval's task correlation must never be blanked (I13).
 */
function completeTask({ taskId, claimEpoch, claimedBy, state, now = store.nowIso() }) {
  vocab.assertCheckpointState(state);
  if (!vocab.TERMINAL_CHECKPOINT_STATES.includes(state)) {
    return { ok: false, code: "state_not_terminal" };
  }
  return tx(db => {
    const info = db.prepare(`
      UPDATE task_checkpoints
         SET state = ?, claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE task_id = ? AND claim_epoch = ? AND claimed_by = ? AND state = 'running'
    `).run(state, now, taskId, claimEpoch, claimedBy);
    expectOneRow(info, "claim_superseded");
    return { taskId, checkpointState: state };
  });
}

/**
 * Re-park an already-claimed task on a NEW approval — the case where a resumed
 * plan reaches a second approval-gated step. Distinct from T1's cold park: the
 * checkpoint already exists and is `running` under this runner's claim, so the
 * transition is fenced and the state moves running → waiting_for_approval.
 */
function reparkClaimed({
  taskId, claimEpoch, claimedBy, stepId, toolName, args, risk = "unknown",
  source = "agent", mode = null, reason = null, requesterIdentity = null,
  timeoutMs = null, evidence = null, evidenceChars = 0, successfulToolEvidence = 0,
  platformExecutionId = null, now = store.nowIso(),
}) {
  if (!store.hasSecretKey()) return { ok: false, code: "secret_key_unavailable" };

  return tx(db => {
    const checkpoint = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ?").get(taskId);
    if (!checkpoint) abort("checkpoint_not_found");

    const digest = keys.argsDigest(args);
    const idempotencyKey = keys.taskIdempotencyKey({
      taskId, stepId, planVersion: checkpoint.plan_version, toolName, argsDigest: digest,
    });
    const approvalId = store.newApprovalId();
    const expiresAt = store.expiresAtFrom(Date.parse(now) || Date.now());

    try {
      db.prepare(`
        INSERT INTO approvals (
          approval_id, status, tool_name, risk, source, mode, reason_encrypted,
          task_id, step_id, plan_version, args_digest, idempotency_key, args_encrypted,
          requester_identity, requested_at, expires_at, updated_at,
          attempt_count, reconciliation_status, platform_execution_id, timeout_ms
        ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'not_required', ?, ?)
      `).run(
        approvalId, toolName, risk, source, mode, store.encryptJson(reason),
        taskId, stepId, checkpoint.plan_version, digest, idempotencyKey, store.encryptJson(args),
        requesterIdentity, now, expiresAt, now, platformExecutionId, timeoutMs
      );
    } catch (error) {
      if (String(error && error.message || "").includes("UNIQUE constraint failed")) {
        abort("duplicate_action", { idempotencyKey });
      }
      throw error;
    }

    const info = db.prepare(`
      UPDATE task_checkpoints
         SET state = 'waiting_for_approval', claimed_by = NULL, lease_expires_at = NULL,
             next_step_id = ?, evidence_encrypted = ?, evidence_chars = ?,
             successful_tool_evidence = ?, updated_at = ?,
             current_approval_id = ?, current_step_id = ?,
             current_args_digest = ?, current_idempotency_key = ?
       WHERE task_id = ? AND claim_epoch = ? AND claimed_by = ? AND state = 'running'
    `).run(
      stepId, store.encryptJson(evidence), evidenceChars, successfulToolEvidence, now,
      approvalId, stepId, digest, idempotencyKey,
      taskId, claimEpoch, claimedBy
    );
    expectOneRow(info, "claim_superseded");

    return { approvalId, idempotencyKey, argsDigest: digest, expiresAt };
  });
}

module.exports = {
  ContinuationAbort,
  park,
  reparkClaimed,
  completeTask,
  approve,
  claim,
  verifyClaim,
  recordActionResult,
  consumeRecordedOutcome,
  wake,
  cancelTask,
  refusePostClaim,
  recoverOrphan,
  renewLease,
  enterReconciliation,
  resolveReconciliation,
  failOverdue,
  needsManualReconciliation,
  isAuthorizedHuman,
  WAKE_TRIGGERS,
  PAIRED_CHECKPOINT_STATE,
  RECONCILIATION_SPEC,
};
