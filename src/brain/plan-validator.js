"use strict";

const { BRAIN_LIMITS, ALLOWED_STEP_TYPES, ALLOWED_CAPABILITIES, FORBIDDEN_KEYS } = require("./config");

/**
 * Deterministic Brain plan validator — the security boundary between an
 * LLM-produced plan and execution.
 *
 * A model never validates its own plan. This module is pure (no I/O, no
 * mutation of its inputs, no model calls): given a candidate plan and the set
 * of Agent-visible tool descriptors, it returns { ok, plan, errors }. The
 * WHOLE plan is rejected if anything fails — no partial execution.
 *
 * Nothing security-relevant is trusted from the model: a step's claimed risk,
 * approval expectation, trust level, provenance, or "verified" flag is ignored.
 * Risk and approval are re-derived at execution time by the dispatcher; the
 * validator only checks that the plan is well-formed, bounded, acyclic, and
 * refers exclusively to known, Agent-visible tools and allowed capabilities.
 */

const STEP_ALLOWED_KEYS = new Set(["id", "type", "capability", "tool", "arguments", "purpose", "depends_on"]);
const PLAN_ALLOWED_KEYS = new Set(["version", "goal", "steps"]);
// Fields a model might emit to assert its own authority. Present anywhere in a
// plan, they are a hard rejection — they must never be honored.
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "risk", "approved", "approval", "approval_id", "authorized", "trust", "trust_level",
  "verified", "provenance", "bypass", "source", "capability_symbol",
]);

function hasForbiddenKeyDeep(value, depth = 0) {
  if (depth > 8) return true; // over-deep structures are themselves suspect
  if (Array.isArray(value)) return value.some(v => hasForbiddenKeyDeep(v, depth + 1));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.includes(key)) return true;
      if (hasForbiddenKeyDeep(value[key], depth + 1)) return true;
    }
  }
  return false;
}

function hasAuthorityKeyDeep(value, depth = 0) {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some(v => hasAuthorityKeyDeep(v, depth + 1));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_AUTHORITY_KEYS.has(key)) return true;
      if (hasAuthorityKeyDeep(value[key], depth + 1)) return true;
    }
  }
  return false;
}

function canonicalToolName(name) {
  return String(name || "").replace(/^sidekick_/, "");
}

/**
 * @param {object} candidate  The parsed plan object produced by the planner.
 * @param {object} opts
 * @param {Array<{name:string, enabled?:boolean}>} opts.agentTools  getToolDefsForSource("agent").filter(enabled)
 * @returns {{ ok: boolean, plan: object|null, errors: string[] }}
 */
function validatePlan(candidate, { agentTools = [] } = {}) {
  const errors = [];
  const fail = (msg) => { errors.push(msg); return { ok: false, plan: null, errors }; };

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return fail("plan_not_object");
  }
  // Reject prototype-pollution and self-authorization shapes before any
  // structural interpretation.
  if (hasForbiddenKeyDeep(candidate)) return fail("forbidden_key");
  if (hasAuthorityKeyDeep(candidate)) return fail("authority_key_not_permitted");

  for (const key of Object.keys(candidate)) {
    if (!PLAN_ALLOWED_KEYS.has(key)) return fail(`unknown_plan_field:${key}`);
  }
  if (Number(candidate.version) !== 1) return fail("unsupported_plan_version");
  if (typeof candidate.goal !== "string" || !candidate.goal.trim()) return fail("missing_goal");
  if (candidate.goal.length > BRAIN_LIMITS.MAX_GOAL_CHARS) return fail("goal_too_large");
  if (!Array.isArray(candidate.steps)) return fail("steps_not_array");
  if (candidate.steps.length === 0) return fail("empty_plan");
  if (candidate.steps.length > BRAIN_LIMITS.MAX_STEPS) return fail("too_many_steps");

  const toolSet = new Set((agentTools || []).filter(t => t && t.enabled !== false).map(t => canonicalToolName(t.name)));
  const ids = new Set();
  const normalizedSteps = [];

  for (let i = 0; i < candidate.steps.length; i++) {
    const step = candidate.steps[i];
    const at = `step[${i}]`;
    if (!step || typeof step !== "object" || Array.isArray(step)) return fail(`${at}:not_object`);
    for (const key of Object.keys(step)) {
      if (!STEP_ALLOWED_KEYS.has(key)) return fail(`${at}:unknown_field:${key}`);
    }
    if (typeof step.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id)) return fail(`${at}:invalid_id`);
    if (ids.has(step.id)) return fail(`${at}:duplicate_id:${step.id}`);
    ids.add(step.id);
    if (!ALLOWED_STEP_TYPES.includes(step.type)) return fail(`${at}:unknown_step_type:${step.type}`);

    const depends = step.depends_on === undefined ? [] : step.depends_on;
    if (!Array.isArray(depends)) return fail(`${at}:depends_on_not_array`);
    if (depends.some(d => typeof d !== "string")) return fail(`${at}:depends_on_not_strings`);

    if (step.type === "memory_retrieval") {
      if (step.capability !== undefined && !ALLOWED_CAPABILITIES.includes(step.capability)) return fail(`${at}:invalid_capability:${step.capability}`);
      if (step.tool !== undefined) return fail(`${at}:memory_step_has_tool`);
    } else if (step.type === "tool") {
      if (typeof step.tool !== "string" || !step.tool) return fail(`${at}:missing_tool`);
      const canonical = canonicalToolName(step.tool);
      if (!/^[a-z][a-z0-9_]*$/.test(canonical)) return fail(`${at}:invalid_tool_name`);
      if (!toolSet.has(canonical)) return fail(`${at}:unknown_or_invisible_tool:${step.tool}`);
      const args = step.arguments === undefined ? {} : step.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) return fail(`${at}:arguments_not_object`);
      if (Object.keys(args).length > BRAIN_LIMITS.MAX_STEP_ARG_KEYS) return fail(`${at}:too_many_arguments`);
    } else if (step.type === "synthesis") {
      if (step.tool !== undefined) return fail(`${at}:synthesis_step_has_tool`);
      if (i !== candidate.steps.length - 1) return fail(`${at}:synthesis_not_last`);
    }
    normalizedSteps.push({ ...step, depends_on: depends });
  }

  // Dependency references must resolve, and no step may depend on itself.
  for (const step of normalizedSteps) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) return fail(`step:${step.id}:unresolved_dependency:${dep}`);
      if (dep === step.id) return fail(`step:${step.id}:self_dependency`);
    }
  }

  // Cycle detection via DFS over the dependency graph.
  const graph = new Map(normalizedSteps.map(s => [s.id, s.depends_on]));
  const state = new Map(); // id -> 0 visiting, 1 done
  const hasCycle = (id) => {
    if (state.get(id) === 1) return false;
    if (state.get(id) === 0) return true;
    state.set(id, 0);
    for (const dep of graph.get(id) || []) {
      if (hasCycle(dep)) return true;
    }
    state.set(id, 1);
    return false;
  };
  for (const step of normalizedSteps) {
    if (hasCycle(step.id)) return fail(`cycle_detected:${step.id}`);
  }

  return {
    ok: true,
    errors: [],
    plan: { version: 1, goal: candidate.goal, steps: normalizedSteps },
  };
}

module.exports = { validatePlan, canonicalToolName, FORBIDDEN_AUTHORITY_KEYS };
