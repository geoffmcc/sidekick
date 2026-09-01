"use strict";

const crypto = require("crypto");

const LIMITS = Object.freeze({ MAX_HYPOTHESES: 32, MAX_EVIDENCE: 96, MAX_REFS_PER_HYPOTHESIS: 16, MAX_TEXT: 1000, MAX_STEPS: 1000 });
const STATES = Object.freeze(["intake", "active", "blocked", "stalled", "complete", "contradicted"]);
const TERMINAL = new Set(["complete", "contradicted"]);
const TRANSITIONS = Object.freeze({ intake: ["active", "blocked"], active: ["blocked", "stalled", "complete", "contradicted"], blocked: ["active", "stalled"], stalled: ["active", "blocked"], complete: [], contradicted: [] });

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function id(value, prefix) { return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)}`; }
function text(value, field) { const result = String(value ?? "").trim(); if (!result || result.length > LIMITS.MAX_TEXT) throw new Error(`${field} must be 1-${LIMITS.MAX_TEXT} characters`); return result; }
function unique(values, max) { return [...new Set((Array.isArray(values) ? values : []).map(String).map(value => value.trim()).filter(Boolean))].slice(0, max); }

function createBeliefState(input = {}) {
  const taskId = text(input.task_id || "unassigned", "task_id");
  return { version: 3, state_id: id({ task_id: taskId, seed: input.seed || "" }, "belief"), task_id: taskId, status: "intake", step: 0, hypotheses: [], evidence: [], contradictions: [], coverage: { required: unique(input.required_evidence, LIMITS.MAX_EVIDENCE), supported: [], missing: unique(input.required_evidence, LIMITS.MAX_EVIDENCE) }, progress: { last_change_step: 0, stall_steps: 0 }, updated_at: input.updated_at || null };
}

function transition(state, next, meta = {}) {
  if (!state || !STATES.includes(next)) throw new Error("unknown belief state");
  if (state.status !== next && !(TRANSITIONS[state.status] || []).includes(next)) throw new Error(`invalid belief transition: ${state.status} -> ${next}`);
  const out = clone(state); out.status = next; out.step = Math.min(LIMITS.MAX_STEPS, Number(state.step || 0) + 1); out.updated_at = meta.updated_at || state.updated_at || null;
  if (TERMINAL.has(next)) out.progress.stall_steps = 0;
  return out;
}

function addHypothesis(state, input) {
  const out = clone(state); if (out.hypotheses.length >= LIMITS.MAX_HYPOTHESES) throw new Error("hypothesis bound exceeded");
  const claim = text(input && input.claim, "claim");
  if (out.hypotheses.some(item => item.claim === claim)) return out;
  out.hypotheses.push({ id: input.id && /^[A-Za-z0-9_-]{1,80}$/.test(input.id) ? input.id : id({ task_id: out.task_id, claim }, "hyp"), claim, status: "open", confidence: Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? input.confidence : 0)), evidence_refs: unique(input.evidence_refs, LIMITS.MAX_REFS_PER_HYPOTHESIS) });
  return out;
}

function addEvidence(state, input) {
  const out = clone(state); if (out.evidence.length >= LIMITS.MAX_EVIDENCE) throw new Error("evidence bound exceeded");
  const ref = text(input && input.ref, "evidence ref");
  if (out.evidence.some(item => item.ref === ref)) return out;
  const entry = { ref, relation: ["supports", "contradicts", "neutral"].includes(input.relation) ? input.relation : "neutral", hypothesis_ids: unique(input.hypothesis_ids, LIMITS.MAX_HYPOTHESES), observed_at: input.observed_at || null };
  out.evidence.push(entry);
  for (const hypothesis of out.hypotheses) if (entry.hypothesis_ids.includes(hypothesis.id) && !hypothesis.evidence_refs.includes(ref)) hypothesis.evidence_refs.push(ref);
  out.contradictions = out.evidence.filter(item => item.relation === "contradicts").map(item => item.ref).slice(0, LIMITS.MAX_EVIDENCE);
  updateCoverage(out); return out;
}

function updateCoverage(state) {
  const supported = state.evidence.filter(item => item.relation === "supports").flatMap(item => item.hypothesis_ids).filter(id => state.hypotheses.some(hypothesis => hypothesis.id === id));
  state.coverage.supported = unique(supported, LIMITS.MAX_EVIDENCE);
  state.coverage.missing = state.coverage.required.filter(ref => !state.evidence.some(item => item.ref === ref || item.hypothesis_ids.includes(ref)));
  return state;
}

function assess(state, options = {}) {
  const out = clone(state); updateCoverage(out);
  const changed = out.coverage.supported.length !== state.coverage.supported.length || out.contradictions.length !== state.contradictions.length;
  out.progress.stall_steps = changed ? 0 : Math.min(LIMITS.MAX_STEPS, Number(state.progress.stall_steps || 0) + 1);
  out.progress.last_change_step = changed ? out.step : state.progress.last_change_step;
  if (!TERMINAL.has(out.status) && out.contradictions.length && options.contradictionTerminal !== false) out.status = "contradicted";
  else if (!TERMINAL.has(out.status) && out.progress.stall_steps >= Math.max(1, Math.min(LIMITS.MAX_STEPS, Number(options.stallAfter || 3)))) out.status = "stalled";
  return { state: out, coverage: { ...out.coverage, ratio: out.coverage.required.length ? out.coverage.supported.length / out.coverage.required.length : 1 }, contradictions: out.contradictions, stalled: out.status === "stalled" || out.progress.stall_steps > 0 && !changed };
}

module.exports = { LIMITS, STATES, createBeliefState, transition, addHypothesis, addEvidence, assess, updateCoverage };
