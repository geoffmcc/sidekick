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

// A few authority key names are also legitimate parameter names on specific
// tools. `source` is the live collision: tail/log_query take it as a read
// filter, and rejecting it made every log-scanning plan unrunnable — the
// planner prompt example itself teaches arguments:{source:...}.
//
// The exemption is per-tool and top-level-only, NOT a blanket "skip anything
// named arguments", because the same word means very different things.
//
// Exempt, and why each is safe:
//   log_query  — a filter over recorded sources (mcp/agent/dashboard).
//   tools      — selects which sources' policy decisions to REPORT; the catalog
//                itself is scoped by getCurrentSource(), not by this argument.
//   mission    — forwarded only into log_query.source / tools.source, both above.
//   tail       — a FILE PATH, not a filter. Safe because enforcePathPolicy()
//                gates it and output is redacted, not because of its semantics.
//
// Deliberately NOT exempt, because for these `source` is an authority or
// execution input — exactly what this check exists to refuse:
//   memory     — source:"correction" sets source_authority 10, the maximum in
//                the system. A model could self-assert top authority and have
//                it recalled into later planning.
//   handoff    — overrides the recorded origin of the handoff.
//   session    — same override on action=begin, persisted and emitted in the
//                session_started event. Audit-provenance rather than privilege,
//                but there is no principled reason to treat it unlike handoff.
//   baseline   — source:"command" is a MODE SELECTOR that reaches execSync.
//                baseline is high risk while bash is critical, so a deployment
//                gating bash would not gate this.
//   watch      — mode selector choosing service|process|endpoint|file.
//
// trust_level is NEVER exempt anywhere: it is a real parameter on
// compute_providers/compute_nodes/compute_route, and permitting it would let a
// plan promote a provider to receive private-classified traffic.
const TOOL_ARGUMENT_AUTHORITY_EXEMPTIONS = new Map([
  ["tail", new Set(["source"])],
  ["log_query", new Set(["source"])],
  ["mission", new Set(["source"])],
  ["tools", new Set(["source"])],
]);
const NO_EXEMPTIONS = new Set();

function hasAuthorityKeyDeep(value, depth = 0, skip = null) {
  if (depth > 8) return true; // fail closed, matching hasForbiddenKeyDeep
  // Subtrees in `skip` are the arguments of well-formed tool steps; they are
  // re-scanned separately against that tool's own exemption set.
  if (skip && skip.has(value)) return false;
  if (Array.isArray(value)) return value.some(v => hasAuthorityKeyDeep(v, depth + 1, skip));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_AUTHORITY_KEYS.has(key)) return true;
      if (hasAuthorityKeyDeep(value[key], depth + 1, skip)) return true;
    }
  }
  return false;
}

// Exemptions apply only to a tool step's OWN argument keys. Nested values are
// scanned with no exemption at all, so a claim cannot be buried one level down.
//
// The nested scan restarts its depth counter at 1 rather than carrying the true
// root depth. That is safe only because hasForbiddenKeyDeep runs FIRST from the
// plan root and rejects anything past depth 8 outright, so a subtree deep enough
// to exploit the smaller counter never reaches here. If that guard is ever
// loosened, pass the true depth in instead.
function argumentsAssertAuthority(args, exempt) {
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key) && !exempt.has(key)) return true;
    if (hasAuthorityKeyDeep(args[key], 1, null)) return true;
  }
  return false;
}

// Whole-plan authority check. The exemption is anchored to structural position
// — steps[i].arguments of a step whose type is "tool" — rather than to any key
// literally named "arguments", which could otherwise appear anywhere in the
// tree and carry the exemption with it.
function planAssertsAuthority(candidate) {
  const toolArguments = [];
  const skip = new Set();
  if (candidate && typeof candidate === "object" && Array.isArray(candidate.steps)) {
    for (const step of candidate.steps) {
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      if (step.type !== "tool") continue;
      // Mirror the strict string check the step loop applies to `tool`. Without
      // it, canonicalToolName's String() coercion would hand an exempt tool's
      // key set to `tool: ["tail"]`. That is rejected later either way, but the
      // two sites must not be able to drift apart.
      if (typeof step.tool !== "string") continue;
      const args = step.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      // Note: `skip` matches by object identity anywhere in the tree, not only
      // at the anchored position. Every member is unconditionally re-scanned
      // below, so an aliased reference is never silently exempted.
      skip.add(args);
      toolArguments.push([canonicalToolName(step.tool), args]);
    }
  }
  if (hasAuthorityKeyDeep(candidate, 0, skip)) return true;
  for (const [tool, args] of toolArguments) {
    if (argumentsAssertAuthority(args, TOOL_ARGUMENT_AUTHORITY_EXEMPTIONS.get(tool) || NO_EXEMPTIONS)) return true;
  }
  return false;
}

function canonicalToolName(name) {
  return String(name || "").replace(/^sidekick_/, "");
}

// Sanitize a model-controlled value before embedding it in an error string.
// Error strings are echoed into the correction prompt, persisted transcripts,
// and platform events, so they must stay deterministic-shaped: word chars only,
// hard length cap, never newlines.
function frag(value) {
  return String(value).replace(/[^\w.-]/g, "_").slice(0, 64);
}

/**
 * @param {object} candidate  The parsed plan object produced by the planner.
 * @param {object} opts
 * @param {Array<{name:string, enabled?:boolean}>} opts.agentTools  getToolDefsForSource("agent").filter(enabled)
 * @returns {{ ok: boolean, plan: object|null, errors: string[] }}
 */
function validatePlan(candidate, { agentTools = [] } = {}) {
  const errors = [];
  const stripped = [];
  const fail = (msg) => { errors.push(msg); return { ok: false, plan: null, errors, stripped }; };

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return fail("plan_not_object");
  }
  // Reject prototype-pollution and self-authorization shapes before any
  // structural interpretation.
  if (hasForbiddenKeyDeep(candidate)) return fail("forbidden_key");
  if (planAssertsAuthority(candidate)) return fail("authority_key_not_permitted");

  // Benign unknown fields ("thoughts", "status", …) are stripped, not fatal:
  // small local models routinely add them despite schema-only prompting, and
  // the validated plan is rebuilt exclusively from whitelisted fields anyway.
  // Authority-shaped and forbidden keys were already hard-rejected above.
  for (const key of Object.keys(candidate)) {
    if (!PLAN_ALLOWED_KEYS.has(key)) stripped.push(`plan:${frag(key)}`);
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
      if (!STEP_ALLOWED_KEYS.has(key)) stripped.push(`${at}:${frag(key)}`);
    }
    if (typeof step.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id)) return fail(`${at}:invalid_id`);
    if (ids.has(step.id)) return fail(`${at}:duplicate_id:${step.id}`);
    ids.add(step.id);
    if (!ALLOWED_STEP_TYPES.includes(step.type)) return fail(`${at}:unknown_step_type:${frag(step.type)}`);

    const depends = step.depends_on === undefined ? [] : step.depends_on;
    if (!Array.isArray(depends)) return fail(`${at}:depends_on_not_array`);
    if (depends.some(d => typeof d !== "string")) return fail(`${at}:depends_on_not_strings`);

    if (step.type === "memory_retrieval") {
      if (step.capability !== undefined && !ALLOWED_CAPABILITIES.includes(step.capability)) return fail(`${at}:invalid_capability:${frag(step.capability)}`);
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
    // Whitelist-copy, scoped per step type: stripped unknown keys must never
    // reach the validated plan, and a field the validator only checks for one
    // step type must not survive on another (e.g. `capability` on a tool step
    // is never validated, so it must not become a validated-plan field a
    // future executor could trust).
    const normalized = { id: step.id, type: step.type, depends_on: depends };
    if (step.type === "memory_retrieval" && step.capability !== undefined) normalized.capability = step.capability;
    if (step.type === "tool") {
      normalized.tool = step.tool;
      normalized.arguments = step.arguments === undefined ? {} : step.arguments;
    }
    if (typeof step.purpose === "string") normalized.purpose = step.purpose.slice(0, 200);
    normalizedSteps.push(normalized);
  }

  // Dependency references must resolve, and no step may depend on itself.
  for (const step of normalizedSteps) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) return fail(`step:${step.id}:unresolved_dependency:${frag(dep)}`);
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
    stripped,
    plan: { version: 1, goal: candidate.goal, steps: normalizedSteps },
  };
}

module.exports = { validatePlan, canonicalToolName, FORBIDDEN_AUTHORITY_KEYS };
