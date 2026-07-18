"use strict";

/**
 * Brain v0.1 configuration and bounds.
 *
 * Two tiers:
 *   - The feature flag and a few operational knobs may be set from the
 *     environment (default OFF — a disabled Brain has zero behavioral effect).
 *   - The security-relevant BOUNDS are NOT environment-overridable, mirroring
 *     agent-continuation's CONTINUATION_LIMITS: a bounded planner cannot be
 *     silently widened at runtime into an unbounded agent loop.
 */

function envFlag(name) {
  const v = process.env[name];
  return v === "1" || String(v).toLowerCase() === "true";
}

function isEnabled() {
  // Read live (not cached) so the flag can be toggled without reload in tests
  // and so importing this module has no config side effect.
  return envFlag("SIDEKICK_BRAIN_ENABLED");
}

// Hard bounds. Frozen and intentionally not read from the environment so a
// plan can never exceed them regardless of deployment configuration.
const BRAIN_LIMITS = Object.freeze({
  MAX_STEPS: 12,                    // total steps in a plan
  MAX_PLANNING_ATTEMPTS: 2,         // bounded correction attempts for the planner
  MAX_RETRIES_PER_STEP: 1,          // per-step retry budget
  MAX_PARALLELISM: 1,               // v0.1 executes steps sequentially
  MAX_TOTAL_TASK_MS: 180000,        // overall Brain task wall-clock budget
  MAX_STEP_MS: 60000,               // per-step budget (tool step)
  MAX_MEMORY_RETRIEVAL_MS: 30000,   // embedding + recall ceiling (matches embed timeout)
  MAX_GENERATION_MS: 120000,        // planning/synthesis generation ceiling
  MAX_GENERATED_TOKENS: 2048,       // cap on model output tokens per generation
  MAX_RETRIEVED_MEMORIES: 8,        // bounded recall count
  MAX_TOOL_OUTPUT_CHARS: 4000,      // per tool-result retained as evidence
  MAX_EVIDENCE_CHARS: 16000,        // total retained evidence budget
  MAX_GOAL_CHARS: 4000,             // reuse the follow-up goal ceiling
  MAX_PLAN_BYTES: 16384,            // reject oversized model plans before parsing depth
  MAX_STEP_ARG_KEYS: 32,            // per-step argument object key ceiling
});

// The only step types Brain v0.1 understands. Anything else is rejected by the
// deterministic validator before execution.
const ALLOWED_STEP_TYPES = Object.freeze(["memory_retrieval", "tool", "synthesis"]);

// Logical capabilities Brain may request from Compute Placement.
const ALLOWED_CAPABILITIES = Object.freeze(["embeddings", "chat", "generate"]);

// Keys that must never appear anywhere in a plan or a step's arguments —
// prototype-pollution shapes are rejected outright, never filtered.
const FORBIDDEN_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

module.exports = {
  isEnabled,
  BRAIN_LIMITS,
  ALLOWED_STEP_TYPES,
  ALLOWED_CAPABILITIES,
  FORBIDDEN_KEYS,
};
