"use strict";

// Shared, bounded completion semantics for the normal Agent loop and Brain.
// This is task state, not chain-of-thought: only short requirement labels,
// evidence references, failures, and verification flags are retained.
const MAX_REQUIREMENTS = 12;
const MAX_TEXT = 240;

function bounded(value, max = MAX_TEXT) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function deriveRequirements(goal) {
  const text = bounded(goal, 4000);
  const parts = text.split(/(?:[.!?;]|\band\b|\bthen\b|\balso\b|\bwhile\b)/i).map(bounded).filter(Boolean);
  return [...new Set((parts.length > 1 ? parts : [text]).slice(0, MAX_REQUIREMENTS))].map((label, index) => ({ id: `req-${index + 1}`, label, status: "pending" }));
}

function createWorkState(goal, { requiresEvidence = false } = {}) {
  const requirements = deriveRequirements(goal);
  return {
    objective: bounded(goal, 4000),
    requirements,
    evidence: [],
    unresolved: requirements.map(item => item.id),
    failures: [],
    verification: [],
    iterations: 0,
    tool_calls: 0,
    replans: 0,
    retries: 0,
    requires_evidence: !!requiresEvidence,
    stopping_condition: null,
  };
}

function recordEvidence(state, item) {
  if (!state || !item) return;
  state.evidence = [...(state.evidence || []), {
    tool: bounded(item.tool, 80),
    success: item.success !== false,
    reference: bounded(item.reference || item.tool, 160),
  }].slice(-64);
  state.tool_calls = Math.min(10000, Number(state.tool_calls || 0) + 1);
}

function recordFailure(state, failure) {
  if (!state) return;
  state.failures = [...(state.failures || []), bounded(failure, 240)].slice(-32);
}

function normalizeDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  const missing = Array.isArray(decision.missing) ? decision.missing.map(item => bounded(item, 180)).filter(Boolean).slice(0, MAX_REQUIREMENTS) : [];
  return { complete: decision.complete === true, missing, reason: bounded(decision.reason, 300), next_action: bounded(decision.next_action, 180) };
}

async function evaluateCompletion({ state, candidate = "", completionGate = null } = {}) {
  const evidenceCount = (state?.evidence || []).filter(item => item.success !== false).length;
  if (state?.requires_evidence && evidenceCount === 0) return { complete: false, missing: ["current evidence"], reason: "required evidence is absent", next_action: "run a governed inspection tool" };
  if (typeof completionGate === "function") {
    const decision = normalizeDecision(await completionGate({ state, candidate: bounded(candidate, 1200) }));
    if (decision) return decision;
  }
  // A short objective can be satisfied by one successful inspection. More
  // materially decomposed objectives require another evidence-bearing pass;
  // the model remains free to choose the next governed capability.
  const materialParts = (state?.requirements || []).length;
  const minimum = state?.requires_evidence ? (materialParts > 1 ? 2 : 1) : 0;
  if (evidenceCount < minimum) return { complete: false, missing: ["remaining objective requirements"], reason: "objective coverage is not yet sufficient", next_action: "continue investigation and update the plan" };
  return { complete: true, missing: [], reason: "bounded evidence and objective coverage are sufficient", next_action: "finalize" };
}

module.exports = { MAX_REQUIREMENTS, createWorkState, deriveRequirements, recordEvidence, recordFailure, evaluateCompletion, bounded };
