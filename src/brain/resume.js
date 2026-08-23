"use strict";

/**
 * Brain task resumption (docs/adr-approval-continuation.md).
 *
 * THE TASK RUNNER IS THE ONLY EXECUTOR OF PLAN STEPS (§1, I3). An approval
 * authorizes an action; it never performs one. `executeApprovedTool` stops
 * being an execution path for task-originated approvals and becomes a state
 * transition (T2) that marks the task runnable; this module then reclaims the
 * task and executes the step through the normal loop, so approved steps and
 * ordinary steps share one code path, one evidence-accumulation rule, and one
 * result-persistence rule.
 *
 * The sequence for one resumption:
 *
 *   T3 claim ──action──→ §6 Stage 2 verify ──ok──→ dispatch ──→ T4A record
 *        │                      │                     │
 *        │                      └──refusal──→ T6 unwind (task wakes, resume claim)
 *        │                                            └──ambiguous+high risk──→ T9
 *        └──resume──→ T4R consume recorded outcome
 *
 * and then the remaining plan steps run, ending in synthesis or another park.
 */

const { BRAIN_LIMITS } = require("./config");
const {
  executePlanSteps,
  newAccumulator,
  accumulateToolResult,
  accumulateRefusal,
  isApprovalRequired,
  buildResult,
} = require("./brain");
const continuation = require("../approvals/continuation");
const store = require("../approvals/store");

/**
 * Renewal interval. Must be comfortably shorter than the lease, because it
 * bounds how long a superseded runner can keep working before it discovers it
 * lost the claim (§5/T8). Matches the existing 30s-against-300s ratio.
 */
function getRenewIntervalMs() {
  const lease = store.getCheckpointLeaseSeconds() * 1000;
  return Math.max(5000, Math.min(30000, Math.floor(lease / 10)));
}

function planStepIndex(plan, stepId) {
  return (plan.steps || []).findIndex(s => s && s.id === stepId);
}

/**
 * Risk is recomputed from the live registry, never taken from the plan: a
 * model-asserted risk carries no authority (Brain's trust boundary). Unknown
 * fails safe — `needsManualReconciliation("unknown")` is true.
 */
function safeToolRisk(toolName) {
  try {
    return require("../tools-legacy").getToolRisk(toolName) || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Terminalise a task this runner holds the claim on, when the failure is not
 * attributable to a live approval.
 *
 * T6 is the right instrument when there IS a bound `executing` approval to
 * unwind. But a RESUME claim has already had its binding cleared, so T6's
 * approval UPDATE matches zero rows and rolls back — leaving the checkpoint
 * `running`, which the scheduler reclaims after every lease expiry, forever.
 * An unrecoverable task must reach a terminal state under this runner's own
 * fence rather than becoming an infinite retry.
 */
function terminaliseUnderClaim({ taskId, claimEpoch, claimedBy, approvalId, outcomeCode, detail, state = "failed" }) {
  if (approvalId) {
    const refused = continuation.refusePostClaim({
      taskId, claimEpoch, claimedBy, approvalId, outcomeCode, actor: claimedBy, detail,
    });
    if (refused.ok) return refused;
  }
  const completed = continuation.completeTask({ taskId, claimEpoch, claimedBy, state });
  try {
    store.recordRecoveryEvent({
      approvalId: approvalId || taskId,
      eventType: "orphaned_checkpoint",
      reconciliationStatus: "manual_review",
      reasonCode: "checkpoint_unrecoverable",
      reasonDetail: detail || `task ${taskId} terminalised as ${state} after ${outcomeCode}`,
      recoveryExecutorId: claimedBy,
    });
  } catch {}
  return completed;
}

/**
 * Rehydrate the accumulator from the checkpoint. Evidence is bounded by the
 * same `MAX_EVIDENCE_CHARS` budget across the whole task, so a resumed task
 * cannot exceed it by restarting the count.
 */
function rehydrate(checkpoint) {
  let evidence = [];
  try {
    evidence = store.decryptJson(checkpoint.evidence_encrypted) || [];
  } catch {
    evidence = [];
  }
  return newAccumulator({
    steps: [],
    evidence: Array.isArray(evidence) ? evidence : [],
    evidenceChars: Number(checkpoint.evidence_chars || 0),
    successfulToolEvidence: Number(checkpoint.successful_tool_evidence || 0),
  });
}

/**
 * Resume one parked task.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.claimedBy                Runner identity for the claim/fence.
 * @param {(tool:string,args:object,meta:object)=>Promise<object>} opts.dispatchApproved
 *        Seam that dispatches an AUTHORIZED step. Production passes the
 *        dispatcher's `executeAuthorizedTaskStep`; tests pass a stub.
 * @param {(tool:string,args:object)=>Promise<object>} opts.callTool  Ordinary dispatcher seam.
 * @param {(input:object)=>Promise<{answer:string}>} opts.synthesize
 * @param {(query:string)=>Promise<Array>} [opts.recallMemory]
 */
async function resumeBrainTask(opts) {
  const {
    taskId,
    claimedBy,
    dispatchApproved,
    callTool,
    synthesize,
    emit = () => {},
    onEvent = () => {},
    redact = (t) => t,
    cancel = { aborted: false },
    clock = null,
    toolContracts = [],
    agentTools = [],
    concurrencyLimit = 1,
    workPackageHooks = null,
  } = opts;

  const now = () => (clock ? clock() : Date.now());
  const cancelled = () => cancel && cancel.aborted;

  const claimed = continuation.claim({ taskId, claimedBy });
  if (!claimed.ok) {
    onEvent("brain.resume_claim_failed", { task_id: taskId, code: claimed.code }, "warning");
    return { state: "not_claimed", code: claimed.code, taskId };
  }

  // The attempt ceiling terminalises the task inside the claim transaction
  // rather than rolling back, so there is nothing left for this runner to do.
  if (claimed.mode === "terminalised") {
    onEvent("brain.attempt_limit_exceeded", { task_id: taskId, code: claimed.code }, "error");
    return { state: "failed", taskId, code: claimed.code };
  }

  const { claimEpoch, checkpoint } = claimed;
  const deadlineMs = checkpoint.deadline_at ? Date.parse(checkpoint.deadline_at) : (now() + BRAIN_LIMITS.MAX_TOTAL_TASK_MS);
  const outOfTime = () => now() >= deadlineMs;

  // T8 renewal. A zero-row renewal means this runner was superseded, so it must
  // abandon immediately rather than continue toward a T4 that will also fail.
  let superseded = false;
  const renewal = setInterval(() => {
    const renewed = continuation.renewLease({ taskId, claimEpoch, claimedBy });
    if (!renewed.ok) {
      superseded = true;
      onEvent("brain.lease_lost", { task_id: taskId, claim_epoch: claimEpoch }, "error");
    }
  }, getRenewIntervalMs());
  if (typeof renewal.unref === "function") renewal.unref();

  const finish = (value) => { clearInterval(renewal); return value; };

  try {
    let plan;
    try {
      plan = store.decryptJson(checkpoint.plan_encrypted);
    } catch {
      plan = null;
    }
    if (!plan || !Array.isArray(plan.steps)) {
      // §4.4: SIDEKICK_SECRET_KEY becomes required to RESUME a task, not merely
      // to approve one. A checkpoint that cannot be rehydrated must fail closed
      // with a distinguishable reason rather than resume with an empty plan.
      const refused = terminaliseUnderClaim({
        taskId, claimEpoch, claimedBy,
        approvalId: checkpoint.current_approval_id,
        outcomeCode: "checkpoint_corrupt",
        detail: `checkpoint ${taskId} could not be rehydrated`,
      });
      onEvent("brain.checkpoint_corrupt", { task_id: taskId, unwound: refused.ok }, "error");
      return finish({ state: "failed", taskId, error: "checkpoint could not be rehydrated", code: "checkpoint_corrupt" });
    }

    const acc = rehydrate(checkpoint);
    const parkedStepId = claimed.mode === "action" ? claimed.stepId : checkpoint.next_step_id;
    const parkedIndex = planStepIndex(plan, parkedStepId);
    if (parkedIndex < 0) {
      const refused = terminaliseUnderClaim({
        taskId, claimEpoch, claimedBy,
        approvalId: checkpoint.current_approval_id,
        outcomeCode: "step_not_in_plan",
        detail: `step ${parkedStepId} is absent from the persisted plan`,
      });
      onEvent("brain.step_not_in_plan", { task_id: taskId, step_id: parkedStepId, unwound: refused.ok }, "error");
      return finish({ state: "failed", taskId, error: "parked step is not in the persisted plan", code: "step_not_in_plan" });
    }
    const parkedStep = plan.steps[parkedIndex];

    // ---- resolve the parked step ----------------------------------------
    if (claimed.mode === "action") {
      const verified = continuation.verifyClaim({ claimResult: claimed, taskCancelled: cancelled() });

      if (!verified.ok) {
        // §6.1 T6: a Stage-2 failure leaves the approval `executing` and the
        // checkpoint `running`; both must be unwound atomically or the task is
        // stranded mid-claim with an approval that can never be consumed.
        const refused = continuation.refusePostClaim({
          taskId, claimEpoch, claimedBy,
          approvalId: claimed.approvalId,
          outcomeCode: verified.outcome,
          actor: claimedBy,
          detail: `post-claim verification refused step ${parkedStepId}`,
        });
        onEvent("brain.step_refused", { task_id: taskId, step_id: parkedStepId, outcome: verified.outcome }, "warning");
        if (!refused.ok) {
          return finish({ state: "failed", taskId, error: "refusal could not be recorded", code: refused.code });
        }
        // `checkpoint_corrupt` and `task_cancelled` terminalise the task; every
        // other refusal wakes it, and a resume claim consumes the outcome.
        if (verified.outcome === "checkpoint_corrupt") return finish({ state: "failed", taskId, code: verified.outcome });
        if (verified.outcome === "task_cancelled") return finish({ state: "cancelled", taskId, code: verified.outcome });
        return finish({ state: "woken", taskId, outcome: verified.outcome, resumable: true });
      }

      if (verified.shortCircuit) {
        // A recorded outcome means the step already ran. Return the stored
        // result rather than dispatching again — the safe, common recovery case.
        onEvent("brain.step_already_recorded", { task_id: taskId, step_id: parkedStepId });
        applyRecordedOutcome(acc, parkedStep, verified.recorded, { onEvent, redact });
      } else if (claimed.requiresReconciliation) {
        // §8/§8.1: high/critical/unknown risk is at-most-once. The prior
        // claimant may or may not have dispatched, and nothing durable records
        // which — so the step is NEVER redispatched on the assumption that it
        // probably had not run. No step result is written: the absence of the
        // row IS the record that the question is open (I15).
        const entered = continuation.enterReconciliation({
          taskId, claimEpoch, recoveryExecutorId: claimedBy, approvalId: claimed.approvalId,
        });
        onEvent("brain.reconciliation_required", {
          task_id: taskId, step_id: parkedStepId, risk: claimed.approval.risk, ok: entered.ok,
        }, "error");
        return finish({ state: "reconciling", taskId, approvalId: claimed.approvalId, code: entered.ok ? null : entered.code });
      } else {
        if (superseded) return finish({ state: "abandoned", taskId, code: "claim_superseded" });
        if (claimed.riskGated) {
          // low/medium risk after an ambiguous window: at-least-once.
          onEvent("brain.step_redispatched", { task_id: taskId, step_id: parkedStepId, risk: claimed.approval.risk }, "warning");
        }

        let toolRes;
        try {
          // Dispatch the approval's OWN tool name, not the plan step's. Stage 2
          // has just proved the two agree, so this is belt-and-braces — but it
          // means the value that reaches the dispatcher is the one the approval
          // record authorizes, so a future gap in that check cannot silently
          // become a tool substitution.
          toolRes = await dispatchApproved(claimed.approval.tool_name, verified.args || {}, {
            approvalId: claimed.approvalId,
            operationId: claimed.operationId,
            idempotencyKey: checkpoint.current_idempotency_key,
            taskId,
            // Default to the per-step budget when the approval carries none:
            // `|| null` made the HIGHEST-risk step in the plan the only one
            // with an unbounded dispatch, since the dispatcher enforces a
            // timeout only when the caller supplies one.
            timeoutMs: claimed.approval.timeout_ms || BRAIN_LIMITS.MAX_STEP_MS,
          });
        } catch (e) {
          acc.steps.push({ type: "tool", id: parkedStep.id, tool: parkedStep.tool, error: redact(String(e && e.message || e)) });
          return finish({ state: "failed", taskId, error: `approved step ${parkedStep.id} failed`, code: "dispatch_threw" });
        }

        const { clipped, isError } = accumulateToolResult(acc, parkedStep, toolRes, { onEvent, redact });
        const recorded = continuation.recordActionResult({
          taskId, claimEpoch, claimedBy,
          approvalId: claimed.approvalId,
          stepId: parkedStep.id,
          planVersion: checkpoint.plan_version,
          argsDigest: checkpoint.current_args_digest,
          idempotencyKey: checkpoint.current_idempotency_key,
          result: { ok: !isError, text: clipped },
          resultDigest: store.argsDigest({ ok: !isError, text: clipped }),
          nextStepId: nextStepIdAfter(plan, parkedIndex),
          evidence: acc.evidence,
          evidenceChars: acc.evidenceChars,
          successfulToolEvidence: acc.successfulToolEvidence,
        });
        if (!recorded.ok) {
          // The fence rejected this write: a superseded runner MUST DISCARD its
          // result rather than overwrite the current claimant's work.
          onEvent("brain.result_discarded", { task_id: taskId, code: recorded.code }, "error");
          return finish({ state: "abandoned", taskId, code: recorded.code });
        }
      }
    } else {
      // Resume claim: consume the durable outcome a wake path already recorded.
      const consumed = continuation.consumeRecordedOutcome({
        taskId, claimEpoch, claimedBy,
        stepId: parkedStepId,
        planVersion: checkpoint.plan_version,
        nextStepId: nextStepIdAfter(plan, parkedIndex),
        evidence: acc.evidence,
        evidenceChars: acc.evidenceChars,
        successfulToolEvidence: acc.successfulToolEvidence,
      });
      if (!consumed.ok) {
        if (consumed.code === "no_recorded_outcome") {
          // A resume claim with nothing to consume. `claim()` only enters
          // resume mode with a live binding when a recorded outcome exists, so
          // reaching here means the binding is already NULL and T7 has no
          // metadata to construct a result row from — it is unrecoverable.
          //
          // This is the ADR §10 out-of-scope case made concrete: checkpoints
          // are written at park points only, so a crash mid-plan AFTER the
          // approved step leaves a cursor pointing at a step that never ran.
          //
          // T7 is NOT the right instrument: it requires the checkpoint to be
          // unclaimed (`waiting_for_approval`/`runnable`), and this runner
          // holds the claim, so it would refuse — leaving the task `running`
          // to be reclaimed after every lease expiry, forever. The task must
          // be terminalised under this runner's own fence instead.
          const failed = continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "failed" });
          try {
            store.recordRecoveryEvent({
              approvalId: checkpoint.current_approval_id || taskId,
              eventType: "orphaned_checkpoint",
              reconciliationStatus: "manual_review",
              reasonCode: "checkpoint_unrecoverable",
              reasonDetail: `resume found no recorded outcome for step ${parkedStepId}; task terminalised`,
              recoveryExecutorId: claimedBy,
            });
          } catch {}
          onEvent("brain.resume_unrecoverable", { task_id: taskId, step_id: parkedStepId, terminalised: failed.ok }, "error");
          return finish({ state: "woken", taskId, outcome: "approval_missing_or_corrupt", resumable: false, code: "checkpoint_unrecoverable" });
        }
        return finish({ state: "failed", taskId, code: consumed.code });
      }
      applyRecordedOutcome(acc, parkedStep, consumed.recorded, { onEvent, redact, result: consumed.result });
    }

    // ---- continue the remaining plan steps -------------------------------
    if (superseded) return finish({ state: "abandoned", taskId, code: "claim_superseded" });

    const outcome = await executePlanSteps({
      plan, startIndex: parkedIndex + 1, acc,
      callTool, emit, onEvent, redact,
      cancelled, outOfTime,
      toolContracts, agentTools, concurrencyLimit,
      workPackageHooks,
    });

    if (outcome.status === "cancelled") {
      continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "cancelled" });
      return finish({ state: "cancelled", taskId, steps: acc.steps });
    }
    if (outcome.status === "timed_out") {
      continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "timed_out" });
      return finish({ state: "timed_out", taskId, steps: acc.steps });
    }
    if (outcome.status === "failed") {
      continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "failed" });
      return finish({ state: "failed", taskId, error: `step ${outcome.stepId} (${outcome.tool}) failed`, steps: acc.steps });
    }

    if (outcome.status === "approval_required") {
      // A resumed plan reached a second approval-gated step. Re-park under the
      // live claim; the unique index rejects a competing live approval for the
      // same task, so this cannot silently orphan the previous authorization.
      const step = outcome.step;
      const reparked = continuation.reparkClaimed({
        taskId, claimEpoch, claimedBy,
        stepId: step.id, toolName: step.tool, args: step.arguments || {},
        // Resolved server-side from the live registry, exactly as the cold-park
        // path does. Omitting it defaulted every second-and-later approval in a
        // plan to `unknown`, so a critical-risk step was presented to the
        // reviewer as unclassified — and the risk shown to a human deciding is
        // the whole point of the field.
        risk: safeToolRisk(step.tool),
        source: "agent",
        requesterIdentity: "agent",
        evidence: acc.evidence,
        evidenceChars: acc.evidenceChars,
        successfulToolEvidence: acc.successfulToolEvidence,
      });
      if (!reparked.ok) {
        continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "failed" });
        return finish({ state: "failed", taskId, error: "second approval could not be checkpointed", code: reparked.code });
      }
      // Same twin problem as the cold park: the dispatcher queued a legacy
      // approval for this step before the checkpoint took ownership of it.
      // Leaving it pending would let a human approve it and dispatch the tool
      // standalone, outside the runner.
      if (outcome.approvalId && outcome.approvalId !== reparked.approvalId) {
        try {
          const superseded = require("../tools-legacy").supersedeLegacyApprovalForTask(outcome.approvalId, {
            taskId,
            replacedBy: reparked.approvalId,
          });
          if (!superseded.ok) {
            onEvent("brain.legacy_approval_not_superseded", { task_id: taskId, approval_id: outcome.approvalId, code: superseded.code }, "error");
          }
        } catch {
          onEvent("brain.legacy_approval_not_superseded", { task_id: taskId, approval_id: outcome.approvalId }, "error");
        }
      }
      acc.steps.push({ type: "tool", id: step.id, tool: step.tool, approval: reparked.approvalId });
      onEvent("brain.waiting_for_approval", { id: step.id, tool: step.tool, approval_id: reparked.approvalId, checkpointed: true }, "warning");
      return finish(buildResult("waiting_for_approval", {
        steps: acc.steps,
        awaitingApproval: { id: step.id, tool: step.tool, approvalId: reparked.approvalId, taskId, checkpointed: true },
      }));
    }

    // ---- verify + synthesize --------------------------------------------
    let classification = {};
    try { classification = JSON.parse(checkpoint.classification_json || "{}"); } catch { classification = {}; }
    const requiresEvidence = !!(classification && classification.requiresTools);

    if (requiresEvidence && acc.successfulToolEvidence === 0) {
      onEvent("brain.evidence_missing", { require_evidence: true }, "error");
      continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "failed" });
      return finish({
        state: "failed", taskId, steps: acc.steps,
        error: "Sidekick could not inspect the requested state: the task required current evidence, but no inspection tool produced any. No answer was fabricated.",
      });
    }

    let goal = "";
    try { goal = store.decryptJson(checkpoint.goal_encrypted) || ""; } catch { goal = ""; }

    let answer = "";
    let finishReason = null;
    try {
      const out = await synthesize({ goal, evidence: acc.evidence, memoryContext: [], requiresEvidence });
      answer = (out && typeof out.answer === "string" ? out.answer : "").trim();
      finishReason = out && out.finishReason || null;
    } catch (e) {
      continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "failed" });
      return finish({
        state: "failed", taskId, steps: acc.steps,
        error: "synthesis error: " + redact(String(e && e.message || e)),
        evidence_count: acc.evidence.length,
      });
    }
    if (!answer) {
      // Same honesty contract as the non-resumed path in brain.js: report the
      // evidence actually collected and whether the token budget truncated it.
      onEvent("brain.synthesis_empty", { evidence_count: acc.evidence.length, finish_reason: finishReason }, "error");
      continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "failed" });
      return finish({
        state: "failed", taskId, steps: acc.steps,
        error: finishReason === "length"
          ? "synthesis produced no usable answer: the model stopped at the generation token budget (" +
            BRAIN_LIMITS.MAX_SYNTHESIS_TOKENS + " tokens) with " + acc.evidence.length + " evidence items"
          : "synthesis produced no answer (evidence items: " + acc.evidence.length + ")",
        evidence_count: acc.evidence.length,
      });
    }

    const completed = continuation.completeTask({ taskId, claimEpoch, claimedBy, state: "completed" });
    if (!completed.ok) {
      onEvent("brain.completion_discarded", { task_id: taskId, code: completed.code }, "error");
      return finish({ state: "abandoned", taskId, code: completed.code });
    }
    acc.steps.push({ type: "done", text: answer });
    return finish(buildResult("completed", { steps: acc.steps, result: answer, evidence_count: acc.evidence.length }));
  } catch (error) {
    return finish({ state: "failed", taskId, error: redact(String(error && error.message || error)), code: "resume_threw" });
  }
}

function nextStepIdAfter(plan, index) {
  const next = (plan.steps || [])[index + 1];
  return next ? next.id : null;
}

/**
 * Feed a durable step outcome to the planner. A `completed` row advances with
 * the stored result; a `refused` row advances with the structured refusal —
 * either way the step is finished and the plan continues, which is the whole
 * point of waking the task (§7, T4R).
 */
function applyRecordedOutcome(acc, step, recorded, { onEvent = () => {}, redact = (value) => value, result = null } = {}) {
  if (!recorded) return acc;
  if (recorded.status === "refused") {
    return accumulateRefusal(acc, {
      stepId: recorded.step_id,
      tool: step ? step.tool : null,
      outcomeCode: recorded.outcome_code,
      approvalId: recorded.approval_id,
    }, { onEvent });
  }

  let stored = result;
  if (stored == null && recorded.result_encrypted) {
    try { stored = store.decryptJson(recorded.result_encrypted); } catch { stored = null; }
  }
  const text = stored && typeof stored.text === "string" ? stored.text : "(recorded result unavailable)";
  const ok = stored ? stored.ok !== false : true;
  return accumulateToolResult(
    acc,
    step || { id: recorded.step_id, tool: "unknown" },
    { isError: !ok, content: [{ type: "text", text }] },
    { onEvent, redact }
  );
}

module.exports = { resumeBrainTask, rehydrate, planStepIndex, applyRecordedOutcome, getRenewIntervalMs };
