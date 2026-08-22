"use strict";

const { BRAIN_LIMITS, ALLOWED_CAPABILITIES } = require("./config");
const { validatePlan } = require("./plan-validator");
const { EVIDENCE_BUDGETS, projectEvidenceItems, projectToolEvidence } = require("../evidence/projector");
const { createWorkState, recordEvidence, evaluateCompletion } = require("../agent/completion-gate");

/**
 * Brain v0.1 orchestrator.
 *
 * A bounded, feature-flagged coordination layer over the existing seams. It
 * performs NO privileged work itself: every tool step runs through the injected
 * `callTool` (the real bridge passes `callAgentTool`, the sole sanctioned
 * dispatcher seam), every embedding/generation runs through injected compute
 * functions (Compute Placement), and memory retrieval runs through injected
 * `recallMemory`. Keeping all effects injected makes the lifecycle, plan
 * validation, evidence gate, and honesty behavior directly testable without a
 * server, a model, or live hardware.
 *
 * Lifecycle states (a task advances monotonically toward exactly one terminal
 * state and, once terminal, never changes — a late tool/compute result can
 * never flip a cancelled/timed-out task to completed):
 *   queued → planning → validating → running → [waiting_for_approval] →
 *   verifying → completed | failed | cancelled | timed_out
 *
 * Untrusted data (the user goal, retrieved memory, tool output, provider
 * output) is never allowed to authorize a tool, inject a step after
 * validation, bypass policy/approval, or mark itself verified. The plan is
 * fixed at validation time; nothing produced during execution can add or
 * mutate steps.
 */

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out", "insufficient_evidence"]);

function nowMs(clock) { return clock ? clock() : Date.now(); }

function truncate(text, max) {
  const s = String(text == null ? "" : text);
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

function isApprovalRequired(toolRes) {
  return !!(toolRes && (toolRes.approvalRequired || toolRes.code === "approval_required" || toolRes.status === "approval_required"));
}

/**
 * Fresh evidence accumulator. Held in one object rather than as loop locals so
 * a resumed task can rehydrate it from its checkpoint and continue accumulating
 * under the same bounds — `MAX_EVIDENCE_CHARS` must apply across the whole
 * task, not per resumption.
 */
function newAccumulator(initial = {}) {
  return {
    steps: initial.steps || [],
    evidence: initial.evidence || [],
    evidenceChars: initial.evidenceChars || 0,
    successfulToolEvidence: initial.successfulToolEvidence || 0,
  };
}

/**
 * Records one completed tool step into the accumulator. Shared by the ordinary
 * path and the resume path so evidence accumulation, truncation, and the
 * "respond is not evidence" rule have exactly ONE implementation (ADR §1).
 */
function accumulateToolResult(acc, step, toolRes, { onEvent = () => {}, redact = (value) => value } = {}) {
  const isError = !!toolRes.isError;
  const text = toolRes.content && toolRes.content[0] && toolRes.content[0].text
    ? toolRes.content[0].text
    : (isError ? "(error)" : "(empty result)");
  // The secret tool's successful result IS the credential; keep it out of the
  // persisted step record, the evidence fed to synthesis prompts, and the
  // planner feedback (errors stay for diagnostics).
  const raw = redact(step.tool.replace(/^sidekick_/, "") === "secret" && !isError
    ? "(sensitive value withheld)"
    : text);
  const clipped = projectToolEvidence({
    tool: step.tool,
    id: step.id,
    text: raw,
    isError,
    redact,
  }, { budget: BRAIN_LIMITS.MAX_TOOL_OUTPUT_CHARS });
  acc.steps.push({
    type: "tool",
    id: step.id,
    tool: step.tool,
    ok: !isError,
    // Action is a bounded enum-like diagnostic value, not the raw argument
    // object. Keep it visible for safe provenance tests without persisting
    // secrets or arbitrary tool arguments in Brain transcripts.
    ...(typeof step.arguments?.action === "string" ? { action: step.arguments.action.slice(0, 120) } : {}),
    result: clipped,
  });
  onEvent("brain.step_completed", { id: step.id, tool: step.tool, ok: !isError });

  const aggregate = projectEvidenceItems([
    ...(Array.isArray(acc.evidence) ? acc.evidence : []),
    { id: step.id, tool: step.tool, text: raw, isError },
  ], {
    totalChars: BRAIN_LIMITS.MAX_EVIDENCE_CHARS,
    perToolChars: Math.min(BRAIN_LIMITS.MAX_TOOL_OUTPUT_CHARS, EVIDENCE_BUDGETS.MAX_TOOL_CHARS),
  });
  acc.evidence = aggregate.items.map(item => ({ id: item.id, tool: item.tool, text: item.text, isError: !!item.isError }));
  acc.evidenceChars = aggregate.diagnostics.chars;
  // The respond echo tool is not evidence about live state. Errors remain in
  // synthesis evidence so their code/message/reason remain actionable.
  if (!isError && step.tool.replace(/^sidekick_/, "") !== "respond") acc.successfulToolEvidence++;
  return { isError, clipped };
}

/**
 * Records a structured refusal outcome (denial, expiry, cancellation,
 * supersession, orphaning) as a step result the planner can act on.
 *
 * ADR §7: these are NOT task failures. They take the same shape a tool error
 * takes today, so no new handling path is introduced, and the planner may
 * explain the outcome or select a materially different route. It may not
 * re-request the same action — the derived idempotency key already exists and
 * collides with the authoritative unique index, which makes the anti-loop
 * protection a storage invariant rather than a prompt instruction.
 */
function accumulateRefusal(acc, { stepId, tool, outcomeCode, approvalId = null, detail = null }, { onEvent = () => {} } = {}) {
  acc.steps.push({
    type: "tool",
    id: stepId,
    tool,
    ok: false,
    outcome: outcomeCode,
    approval_id: approvalId,
    detail: detail || null,
  });
  onEvent("brain.step_refused", { id: stepId, tool, outcome: outcomeCode, approval_id: approvalId }, "warning");
  return acc;
}

/**
 * Executes plan steps from `startIndex`, accumulating into `acc`.
 *
 * Extracted from `runBrainTask` so the resume path (src/brain/resume.js) runs
 * the SAME loop rather than a parallel copy: approved steps and ordinary steps
 * must share one code path, one evidence-accumulation rule, and one
 * result-persistence rule (ADR §1). Returns a discriminated outcome rather than
 * a terminal envelope, because the caller owns state transitions.
 */
async function executePlanSteps({
  plan,
  startIndex = 0,
  acc,
  callTool,
  emit = () => {},
  onEvent = () => {},
  redact = (t) => t,
  cancelled = () => false,
  outOfTime = () => false,
}) {
  const steps = plan.steps || [];
  for (let index = startIndex; index < steps.length; index++) {
    const step = steps[index];
    if (cancelled()) return { status: "cancelled", index };
    if (outOfTime()) return { status: "timed_out", index };
    if (step.type !== "tool") continue; // memory already retrieved; synthesis handled by the caller

    emit({ type: "brain_step", step: "tool", id: step.id, tool: step.tool });
    onEvent("brain.step_started", { id: step.id, tool: step.tool });

    let toolRes;
    try {
      toolRes = await callTool(step.tool, step.arguments || {});
    } catch (e) {
      acc.steps.push({ type: "tool", id: step.id, tool: step.tool, error: redact(String(e && e.message || e)) });
      // A tool step failure is honest failure, never fabricated evidence.
      return { status: "failed", index, stepId: step.id, tool: step.tool };
    }

    // Approval-required is a first-class waiting state, never retried or
    // bypassed. The plan does not proceed; the task parks awaiting a human.
    if (isApprovalRequired(toolRes)) {
      return { status: "approval_required", index, step, approvalId: toolRes.approvalId || null };
    }

    accumulateToolResult(acc, step, toolRes, { onEvent, redact });
  }
  return { status: "completed", index: steps.length };
}

/**
 * @param {object} opts
 * @param {string} opts.goal
 * @param {object} opts.classification  { requiresTools, reason } from classifyEvidenceRequirement
 * @param {(candidatePlanContext:object)=>Promise<object>} opts.plan  Produces a candidate plan object (LLM-backed in production).
 * @param {Array<{name:string,enabled?:boolean}>} opts.agentTools  Agent-visible tool catalog.
 * @param {(name:string,args:object)=>Promise<object>} opts.callTool  Dispatcher seam (callAgentTool).
 * @param {(query:string)=>Promise<Array>} [opts.recallMemory]  Bounded, scoped, redacted recall.
 * @param {(evidence:object)=>Promise<{answer:string}>} opts.synthesize  Final-answer generation (LLM-backed).
 * @param {(event:object)=>void} [opts.emit]
 * @param {(type:string,payload:object,severity?:string)=>void} [opts.onEvent]
 * @param {(text:string)=>string} [opts.redact]
 * @param {{aborted:boolean}} [opts.cancel]  Cooperative cancellation flag.
 * @param {()=>number} [opts.clock]  Injectable clock for deterministic timeout tests.
 * @param {number} [opts.deadlineMs]  Absolute deadline; defaults to now + MAX_TOTAL_TASK_MS.
 * @returns {Promise<object>} result envelope
 */
async function runBrainTask(opts) {
  const {
    goal,
    classification,
    plan: planFn,
    agentTools = [],
    callTool,
    recallMemory = null,
    synthesize,
    emit = () => {},
    onEvent = () => {},
    redact = (t) => t,
    cancel = { aborted: false },
    clock = null,
    // Durable-continuation seam (docs/adr-approval-continuation.md). Optional:
    // when absent, Brain behaves exactly as v0.1 and a parked task is lost.
    persistence = null,
    taskId = null,
    // Platform-execution correlation for the durable checkpoint.
    lineage = {},
    completionGate = null,
    workState = null,
    maxWorkRounds = 4,
    onCheckpoint = null,
  } = opts;

  const startedAt = nowMs(clock);
  const deadlineMs = opts.deadlineMs || (startedAt + BRAIN_LIMITS.MAX_TOTAL_TASK_MS);

  const steps = [];
  const taskState = workState || createWorkState(goal, { requiresEvidence: !!(classification && classification.requiresTools) });
  let state = "queued";
  const setState = (next) => {
    if (TERMINAL.has(state)) return; // terminal is sticky — never re-enter or flip
    state = next;
    emit({ type: "brain_state", state });
    onEvent("brain.state", { state });
  };

  const outOfTime = () => nowMs(clock) >= deadlineMs;
  const cancelled = () => cancel && cancel.aborted;

  const terminal = (finalState, { result = "", error = "", extra = {} } = {}) => {
    // Guard: only the FIRST terminal transition wins. A result arriving after
    // cancellation/timeout cannot resurrect the task.
    if (TERMINAL.has(state)) {
      return buildResult(state, { steps, result: "", error: "already terminal", ...extra });
    }
    state = finalState;
    emit({ type: "brain_state", state });
    onEvent("brain.state", { state });
    return buildResult(finalState, { steps, result, error, ...extra });
  };

  if (cancelled()) return terminal("cancelled", { error: "cancelled before start" });

  // ---- plan ----------------------------------------------------------------
  setState("planning");
  const requiresEvidence = !!(classification && classification.requiresTools);

  let memoryContext = [];
  if (recallMemory) {
    try {
      const recalled = await recallMemory(goal);
      memoryContext = Array.isArray(recalled) ? recalled.slice(0, BRAIN_LIMITS.MAX_RETRIEVED_MEMORIES) : [];
      if (memoryContext.length) {
        steps.push({ type: "memory", count: memoryContext.length });
        emit({ type: "brain_step", step: "memory_retrieval", count: memoryContext.length });
      }
    } catch (e) {
      // Memory retrieval is best-effort context, never a hard dependency; its
      // failure must not fabricate or fail the task on its own.
      onEvent("brain.memory_failed", { error: redact(String(e && e.message || e)) }, "warning");
    }
  }
  if (cancelled()) return terminal("cancelled");
  if (outOfTime()) return terminal("timed_out", { error: "planning deadline exceeded" });

  // Bounded planning attempts: a rejected plan gets ONE deterministic
  // correction round with the validator's errors fed back verbatim. The
  // validator (never the model) decides acceptance on every attempt.
  let validation = null;
  let priorErrors = null;
  for (let attempt = 1; attempt <= BRAIN_LIMITS.MAX_PLANNING_ATTEMPTS; attempt++) {
    if (cancelled()) return terminal("cancelled");
    if (outOfTime()) return terminal("timed_out", { error: "planning deadline exceeded" });
    let candidate;
    try {
      candidate = await planFn({ goal, classification, memoryContext, priorErrors });
    } catch (e) {
      return terminal("failed", { error: "planning error: " + redact(String(e && e.message || e)) });
    }

    // ---- validate (deterministic; a model never validates its own plan) ----
    setState("validating");
    validation = validatePlan(candidate, { agentTools });
    onEvent("brain.plan_validated", { attempt, ok: validation.ok, errors: validation.errors.slice(0, 8), stripped: (validation.stripped || []).slice(0, 8), step_count: validation.plan ? validation.plan.steps.length : 0 });
    if (validation.ok) break;
    priorErrors = validation.errors;
    setState("planning");
  }
  if (!validation || !validation.ok) {
    const errs = validation ? validation.errors : [];
    // Validator errors are sanitized at the source (frag()), but redact here
    // too: this string lands in the persisted transcript.
    return terminal("failed", { error: redact("plan rejected: " + errs.slice(0, 4).join("; ")), extra: { plan_errors: errs } });
  }
  let validated = validation.plan;
  emit({ type: "brain_plan", goal: validated.goal, steps: validated.steps.map(s => ({ id: s.id, type: s.type, tool: s.tool || null, purpose: s.purpose || null })) });

  // ---- run ----------------------------------------------------------------
  setState("running");
  const acc = newAccumulator({ steps });
  let awaitingApproval = null;

  let outcome = await executePlanSteps({
    plan: validated, startIndex: 0, acc,
    callTool, emit, onEvent, redact, cancelled, outOfTime,
  });
  if (typeof onCheckpoint === "function") onCheckpoint(taskState);

  // A completed finite plan is not automatically a completed objective. Use
  // the shared gate, and if material requirements remain, obtain and validate
  // another bounded plan from the model before synthesizing.
  let workRound = 0;
  let accountedEvidence = 0;
  while (outcome.status === "completed" && workRound < Math.max(1, Math.min(8, Number(maxWorkRounds) || 4))) {
    for (const item of (acc.evidence || []).slice(accountedEvidence)) recordEvidence(taskState, { tool: item.tool || "inspection", success: item.ok !== false, reference: item.tool || "evidence" });
    accountedEvidence = (acc.evidence || []).length;
    const completion = await evaluateCompletion({ state: taskState, candidate: "", completionGate });
    if (completion.complete) break;
    workRound++;
    taskState.replans = Math.min(32, (taskState.replans || 0) + 1);
    emit({ type: "brain_step", step: "replan", round: workRound });
    onEvent("brain.replan", { round: workRound, missing: completion.missing, reason: completion.reason }, "info");
    let nextCandidate;
    try {
      nextCandidate = await planFn({ goal, classification, memoryContext, priorErrors: [completion.reason], progress: { missing: completion.missing, evidence_count: acc.evidence.length, round: workRound } });
    } catch (e) {
      return terminal("failed", { error: "replanning error: " + redact(String(e && e.message || e)) });
    }
    const nextValidation = validatePlan(nextCandidate, { agentTools });
    if (!nextValidation.ok) return terminal("failed", { error: redact("replan rejected: " + nextValidation.errors.slice(0, 4).join("; ")) });
    validated = nextValidation.plan;
    outcome = await executePlanSteps({ plan: validated, startIndex: 0, acc, callTool, emit, onEvent, redact, cancelled, outOfTime });
    if (typeof onCheckpoint === "function") onCheckpoint(taskState);
  }

  if (outcome.status === "completed" && workRound >= Math.max(1, Math.min(8, Number(maxWorkRounds) || 4))) {
    const completion = await evaluateCompletion({ state: taskState, candidate: "", completionGate });
    if (!completion.complete) return terminal("insufficient_evidence", { error: "bounded work rounds exhausted before objective completion", extra: { missing: completion.missing, work_rounds: workRound } });
  }

  if (outcome.status === "cancelled") return terminal("cancelled");
  if (outcome.status === "timed_out") return terminal("timed_out", { error: "task deadline exceeded" });
  if (outcome.status === "failed") {
    return terminal("failed", { error: `step ${outcome.stepId} (${outcome.tool}) failed`, extra: { failed_step: outcome.stepId } });
  }

  if (outcome.status === "approval_required") {
    const step = outcome.step;
    awaitingApproval = { id: step.id, tool: step.tool, approvalId: outcome.approvalId };

    // ADR docs/adr-approval-continuation.md §5/T1. Without a `persistence`
    // seam the task parks exactly as Brain v0.1 did: the plan, evidence and
    // counters are stack locals that are garbage-collected, and the approval
    // has nothing to return to. With one, the whole suspended execution is
    // written durably and atomically with the approval that authorizes the
    // next action — which is what makes resumption possible at all (I9).
    if (persistence && typeof persistence.park === "function") {
      let parked;
      try {
        parked = await persistence.park({
          taskId,
          goal: validated.goal,
          classification,
          plan: validated,
          stepId: step.id,
          toolName: step.tool,
          args: step.arguments || {},
          stepIndex: outcome.index,
          evidence: acc.evidence,
          evidenceChars: acc.evidenceChars,
          successfulToolEvidence: acc.successfulToolEvidence,
          deadlineAt: new Date(deadlineMs).toISOString(),
          // Correlation, so a checkpoint can be joined back to the platform
          // execution and follow-up thread it belongs to. The schema has always
          // had these columns; not passing them left every checkpoint
          // permanently uncorrelated.
          platformExecutionId: lineage.platformExecutionId,
          rootExecutionId: lineage.rootExecutionId,
          rootTaskId: lineage.rootTaskId,
        });
      } catch (e) {
        parked = { ok: false, code: "park_threw", detail: redact(String(e && e.message || e)) };
      }
      if (!parked || !parked.ok) {
        // A task that cannot be persisted must fail closed rather than park
        // into a state nothing can ever resume. Reporting the park failure
        // honestly is the point: a silent park is the pre-ADR bug.
        onEvent("brain.park_failed", { id: step.id, tool: step.tool, code: parked && parked.code }, "error");
        return terminal("failed", {
          error: `step ${step.id} (${step.tool}) required approval but the task could not be checkpointed (${(parked && parked.code) || "unknown"})`,
          extra: { failed_step: step.id },
        });
      }
      // The dispatcher already queued a LEGACY approval for this step — it
      // cannot know the caller is a task. Now that T1 owns the action durably,
      // that twin must be terminalised: leaving it pending would show two
      // approvals for one action, and approving the legacy one dispatches the
      // tool standalone and discards the result, which is the exact bug the
      // checkpoint exists to remove.
      const legacyId = outcome.approvalId;
      if (legacyId && legacyId !== parked.approvalId && persistence.supersedeLegacyApproval) {
        try {
          const superseded = await persistence.supersedeLegacyApproval(legacyId, {
            taskId,
            replacedBy: parked.approvalId,
          });
          if (!superseded || !superseded.ok) {
            onEvent("brain.legacy_approval_not_superseded", { id: step.id, approval_id: legacyId, code: superseded && superseded.code }, "error");
          }
        } catch (e) {
          onEvent("brain.legacy_approval_not_superseded", { id: step.id, approval_id: legacyId, error: redact(String(e && e.message || e)) }, "error");
        }
      }

      awaitingApproval.approvalId = parked.approvalId || awaitingApproval.approvalId;
      awaitingApproval.legacyApprovalId = legacyId || null;
      awaitingApproval.taskId = taskId;
      awaitingApproval.checkpointed = true;
    }

    acc.steps.push({ type: "tool", id: step.id, tool: step.tool, approval: awaitingApproval.approvalId });
    state = "waiting_for_approval";
    emit({ type: "brain_state", state });
    onEvent("brain.waiting_for_approval", {
      id: step.id, tool: step.tool,
      approval_id: awaitingApproval.approvalId,
      checkpointed: !!awaitingApproval.checkpointed,
    }, "warning");
    return buildResult("waiting_for_approval", { steps: acc.steps, awaitingApproval });
  }

  const evidence = acc.evidence;
  const successfulToolEvidence = acc.successfulToolEvidence;

  // ---- verify (evidence gate) ---------------------------------------------
  setState("verifying");
  if (cancelled()) return terminal("cancelled");
  if (outOfTime()) return terminal("timed_out");
  if (requiresEvidence && successfulToolEvidence === 0) {
    // A live-state request with no successful evidence must fail honestly —
    // never synthesize a plausible current-state answer from nothing.
    onEvent("brain.evidence_missing", { require_evidence: true }, "error");
    return terminal("failed", { error: "Sidekick could not inspect the requested state: the task required current evidence, but no inspection tool produced any. No answer was fabricated." });
  }

  // ---- synthesize ----------------------------------------------------------
  let answer = "";
  let finishReason = null;
  try {
    const out = await synthesize({ goal: validated.goal, evidence, memoryContext, requiresEvidence });
    answer = (out && typeof out.answer === "string" ? out.answer : "").trim();
    finishReason = out && out.finishReason || null;
  } catch (e) {
    return terminal("failed", {
      error: "synthesis error: " + redact(String(e && e.message || e)),
      extra: { evidence_count: evidence.length },
    });
  }
  if (!answer) {
    // Report the evidence that WAS collected: a synthesis failure after ten
    // successful tool calls is a different problem from one after zero, and
    // reporting evidence_count 0 for both hid that.
    onEvent("brain.synthesis_empty", { evidence_count: evidence.length, finish_reason: finishReason }, "error");
    return terminal("failed", {
      error: finishReason === "length"
        ? "synthesis produced no usable answer: the model stopped at the generation token budget (" +
          BRAIN_LIMITS.MAX_SYNTHESIS_TOKENS + " tokens) with " + evidence.length + " evidence items"
        : "synthesis produced no answer (evidence items: " + evidence.length + ")",
      extra: { evidence_count: evidence.length },
    });
  }
  if (cancelled()) return terminal("cancelled"); // a cancel during synthesis still wins

  return terminal("completed", { result: answer, extra: { evidence_count: evidence.length } });
}

function buildResult(state, { steps, result = "", error = "", evidence_count = 0, plan_errors = null, failed_step = null, awaitingApproval = null } = {}) {
  return {
    state,
    status: state, // alias for callers expecting `status`
    result,
    error,
    steps,
    evidenceCount: evidence_count,
    planErrors: plan_errors,
    failedStep: failed_step,
    awaitingApproval,
  };
}

module.exports = {
  runBrainTask,
  TERMINAL_STATES: TERMINAL,
  // Shared with the resume path so approved and ordinary steps run one loop.
  executePlanSteps,
  newAccumulator,
  accumulateToolResult,
  accumulateRefusal,
  isApprovalRequired,
  buildResult,
};
