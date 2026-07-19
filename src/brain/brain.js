"use strict";

const { BRAIN_LIMITS, ALLOWED_CAPABILITIES } = require("./config");
const { validatePlan } = require("./plan-validator");

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

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

function nowMs(clock) { return clock ? clock() : Date.now(); }

function truncate(text, max) {
  const s = String(text == null ? "" : text);
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
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
  } = opts;

  const startedAt = nowMs(clock);
  const deadlineMs = opts.deadlineMs || (startedAt + BRAIN_LIMITS.MAX_TOTAL_TASK_MS);

  const steps = [];
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
  const validated = validation.plan;
  emit({ type: "brain_plan", goal: validated.goal, steps: validated.steps.map(s => ({ id: s.id, type: s.type, tool: s.tool || null, purpose: s.purpose || null })) });

  // ---- run ----------------------------------------------------------------
  setState("running");
  const evidence = [];
  let evidenceChars = 0;
  let successfulToolEvidence = 0;
  let awaitingApproval = null;

  for (const step of validated.steps) {
    if (cancelled()) return terminal("cancelled");
    if (outOfTime()) return terminal("timed_out", { error: "task deadline exceeded" });
    if (step.type !== "tool") continue; // memory already retrieved; synthesis handled below

    emit({ type: "brain_step", step: "tool", id: step.id, tool: step.tool });
    onEvent("brain.step_started", { id: step.id, tool: step.tool });

    let toolRes;
    try {
      toolRes = await callTool(step.tool, step.arguments || {});
    } catch (e) {
      steps.push({ type: "tool", id: step.id, tool: step.tool, error: redact(String(e && e.message || e)) });
      // A tool step failure is honest failure, never fabricated evidence.
      return terminal("failed", { error: `step ${step.id} (${step.tool}) failed`, extra: { failed_step: step.id } });
    }

    // Approval-required is a first-class waiting state, never retried or
    // bypassed. The plan does not proceed; the task parks awaiting a human.
    if (toolRes && (toolRes.approvalRequired || toolRes.code === "approval_required" || toolRes.status === "approval_required")) {
      awaitingApproval = { id: step.id, tool: step.tool, approvalId: toolRes.approvalId || null };
      steps.push({ type: "tool", id: step.id, tool: step.tool, approval: awaitingApproval.approvalId });
      state = "waiting_for_approval";
      emit({ type: "brain_state", state });
      onEvent("brain.waiting_for_approval", { id: step.id, tool: step.tool, approval_id: awaitingApproval.approvalId }, "warning");
      return buildResult("waiting_for_approval", { steps, awaitingApproval });
    }

    const isError = !!toolRes.isError;
    const text = toolRes.content && toolRes.content[0] && toolRes.content[0].text ? toolRes.content[0].text : (isError ? "(error)" : "(empty result)");
    const clipped = truncate(text, BRAIN_LIMITS.MAX_TOOL_OUTPUT_CHARS);
    steps.push({ type: "tool", id: step.id, tool: step.tool, ok: !isError, result: clipped });
    onEvent("brain.step_completed", { id: step.id, tool: step.tool, ok: !isError });

    if (!isError && evidenceChars < BRAIN_LIMITS.MAX_EVIDENCE_CHARS) {
      const room = BRAIN_LIMITS.MAX_EVIDENCE_CHARS - evidenceChars;
      const piece = clipped.slice(0, room);
      evidence.push({ id: step.id, tool: step.tool, text: piece });
      evidenceChars += piece.length;
      // The respond echo tool is not evidence about live state.
      if (step.tool.replace(/^sidekick_/, "") !== "respond") successfulToolEvidence++;
    }
  }

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
  try {
    const out = await synthesize({ goal: validated.goal, evidence, memoryContext, requiresEvidence });
    answer = (out && typeof out.answer === "string" ? out.answer : "").trim();
  } catch (e) {
    return terminal("failed", { error: "synthesis error: " + redact(String(e && e.message || e)) });
  }
  if (!answer) return terminal("failed", { error: "synthesis produced no answer" });
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

module.exports = { runBrainTask, TERMINAL_STATES: TERMINAL };
