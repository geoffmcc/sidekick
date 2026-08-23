"use strict";

const STATUSES = Object.freeze(["verified", "partially_verified", "incomplete", "contradicted", "unable_to_verify", "waiting_for_approval", "waiting_for_information", "budget_exhausted"]);

function clean(value, max = 500) { return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }

// Freshness is a property of the recorded observation and the recipe that
// requested it, not a permanent label supplied by a caller.  Older in-memory
// test evidence has no timestamp and remains compatible; persisted outcomes
// always have observed_at and are checked against the recipe window.
function outcomeIsFresh(recipe, outcome, now = Date.now()) {
  if (!outcome || outcome.freshness_state !== "fresh") return false;
  if (!outcome.observed_at || !recipe || recipe.freshness_ms == null) return true;
  const observed = Date.parse(String(outcome.observed_at));
  const windowMs = Number(recipe.freshness_ms);
  if (!Number.isFinite(observed) || !Number.isFinite(windowMs) || windowMs < 0) return false;
  return observed <= now && now - observed <= windowMs;
}

function successfulFreshOutcome(recipe, outcome, now = Date.now()) {
  return outcome && outcome.observation_state === "successful" && outcome.independence_state === "independent" && outcomeIsFresh(recipe, outcome, now);
}

// Verification consumes evidence; it never creates authority and never calls a
// tool. Any live verification capability must be selected and dispatched by
// the normal Agent/dispatcher loop before this decision is recorded.
function verifyTaskResult({ criteria = [], evidence = [], result = "", requires_live_evidence = false, terminal_state = "completed" } = {}) {
  const criterionList = Array.isArray(criteria) ? criteria.slice(0, 50).map(item => clean(item)).filter(Boolean) : [];
  const evidenceList = Array.isArray(evidence) ? evidence.slice(0, 100).map(item => ({ tool: clean(item.tool, 120), ok: item.ok !== false, reference: clean(item.reference || item.id, 160), text: clean(item.text, 800) })) : [];
  const usable = evidenceList.filter(item => item.ok && item.reference);
  const contradictions = evidenceList.filter(item => /\b(?:contradict|failed|error|unavailable|denied)\b/i.test(item.text));
  if (terminal_state === "cancelled") return { status: "incomplete", criteria_checked: 0, reason: "task cancelled", evidence: usable };
  if (terminal_state === "timed_out") return { status: "budget_exhausted", criteria_checked: 0, reason: "task budget or deadline exhausted", evidence: usable };
  if (terminal_state === "waiting_for_approval") return { status: "waiting_for_approval", criteria_checked: 0, reason: "approval is outstanding", evidence: usable };
  if (contradictions.length && !usable.length) return { status: "contradicted", criteria_checked: 0, reason: "available evidence contains only failure or contradictory observations", evidence: [] };
  if (requires_live_evidence && usable.length === 0) return { status: "unable_to_verify", criteria_checked: 0, reason: "no current evidence reference was produced", evidence: [] };
  if (!result || !clean(result, 20_000)) return { status: "incomplete", criteria_checked: 0, reason: "no result was produced", evidence: usable };
  if (criterionList.length === 0) return { status: usable.length ? "partially_verified" : "unable_to_verify", criteria_checked: 0, reason: "no explicit success criteria were supplied", evidence: usable };
  const covered = criterionList.filter(criterion => usable.some(item => item.text.toLowerCase().includes(criterion.toLowerCase())));
  const status = covered.length === criterionList.length && !contradictions.length ? "verified" : covered.length ? "partially_verified" : "unable_to_verify";
  return { status, criteria_checked: criterionList.length, criteria_covered: covered.length, criteria: criterionList.map(text => ({ text, state: covered.includes(text) ? "supported" : "unverified" })), evidence: usable, reason: status === "verified" ? "every criterion has supporting evidence" : "one or more criteria lack independent supporting evidence" };
}

function applyRecipeGates(verification, recipes = [], outcomes = []) {
  if (!Array.isArray(recipes) || recipes.length === 0) return verification;
  const successful = new Set(outcomes.filter(item => recipes.some(recipe => String(recipe.recipe_id) === String(item.recipe_id) && successfulFreshOutcome(recipe, item))).map(item => item.recipe_id));
  const missing = recipes.filter(recipe => !successful.has(recipe.recipe_id)).map(recipe => clean(recipe.requirement_id || recipe.recipe_id, 160));
  if (!missing.length) return { ...verification, recipe_gates: recipes.map(recipe => ({ recipe_id: recipe.recipe_id, state: "satisfied" })) };
  return { ...verification, status: "unable_to_verify", reason: "one or more durable verification recipe gates lack fresh successful outcomes", missing_recipe_gates: missing, recipe_gates: recipes.map(recipe => ({ recipe_id: recipe.recipe_id, state: successful.has(recipe.recipe_id) ? "satisfied" : "unverified" })) };
}

function applyReceiptGates(verification, receipts = []) {
  const missing = (receipts || []).filter(receipt => receipt && receipt.effect_class && receipt.effect_class !== "read_only" && ["finalized", "verified", "dispatched", "ambiguous"].includes(receipt.outcome_state || receipt.dispatch_state) && !receipt.verification_recipe_ref).map(receipt => clean(receipt.receipt_id, 160));
  if (!missing.length) return verification;
  return { ...verification, status: "unable_to_verify", reason: "one or more mutating operation receipts have no governed verification recipe", missing_receipt_gates: missing };
}

// Milestones are completion gates, not progress decoration. A milestone is
// verified only when each governed gate has fresh, independent evidence from
// the durable verification ledger; model-reported milestone status is data.
function applyPlanGates(verification, plans = [], outcomes = [], recipes = []) {
  const plan = Array.isArray(plans) && plans.length ? plans[0] : null;
  const milestones = Array.isArray(plan?.milestones) ? plan.milestones : [];
  if (!plan || !milestones.length) return verification;
  const gates = Array.isArray(plan.verification_gates) ? plan.verification_gates : [];
  const successful = (outcomes || []).filter(item => {
    const gate = (plan?.verification_gates || []).find(candidate => String(candidate.recipe_id || candidate.id || candidate.requirement_id) === String(item.recipe_id));
    const recipe = (recipes || []).find(candidate => String(candidate.recipe_id) === String(item.recipe_id));
    return gate && successfulFreshOutcome(recipe || gate, item);
  });
  const evidenceKeys = new Set(successful.flatMap(item => [item.recipe_id, item.requirement_id].filter(Boolean).map(String)));
  const states = milestones.map(milestone => {
    const id = clean(milestone?.id || "", 160);
    const refs = Array.isArray(milestone?.verification_gate_ids) ? milestone.verification_gate_ids.map(String) : milestone?.verification_gate ? [String(milestone.verification_gate)] : [];
    const required = refs.map(ref => gates.find(gate => String(gate?.id || gate?.recipe_id || gate?.requirement_id || "") === ref) || { id: ref, recipe_id: ref });
    const missing = required.filter(gate => !evidenceKeys.has(String(gate.recipe_id || gate.id || gate.requirement_id || ""))).map(gate => clean(gate.id || gate.requirement_id || gate.recipe_id, 160));
    return { id, state: id && required.length && !missing.length ? "verified" : "unverified", required_gates: required.map(gate => clean(gate.id || gate.recipe_id || gate.requirement_id, 160)), missing_gates: missing, reason: required.length ? (missing.length ? "milestone lacks fresh independent gate evidence" : "all milestone gates satisfied") : "milestone has no governed verification gate" };
  });
  const missing = states.filter(item => item.state !== "verified").map(item => item.id || "milestone");
  if (!missing.length) return { ...verification, milestone_gates: states };
  return { ...verification, status: "unable_to_verify", reason: "one or more hierarchical milestones lack fresh independent verification", missing_milestones: missing, milestone_gates: states };
}

function expectationSatisfied(result, text, expected = {}) {
  if (expected.text_includes != null && !text.includes(String(expected.text_includes))) return false;
  if (expected.text_excludes != null && text.includes(String(expected.text_excludes))) return false;
  if (expected.result_ok != null && Boolean(!result?.isError) !== Boolean(expected.result_ok)) return false;
  if (expected.json_path != null) {
    let value;
    try {
      const parsed = JSON.parse(text);
      const path = String(expected.json_path).split(".").filter(part => /^[A-Za-z0-9_-]{1,80}$/.test(part));
      if (!path.length || path.join(".") !== String(expected.json_path)) return false;
      value = path.reduce((current, key) => current == null ? undefined : current[key], parsed);
    } catch { return false; }
    if (Object.prototype.hasOwnProperty.call(expected, "equals") && JSON.stringify(value) !== JSON.stringify(expected.equals)) return false;
    if (Object.prototype.hasOwnProperty.call(expected, "contains") && !(Array.isArray(value) ? value.includes(expected.contains) : String(value || "").includes(String(expected.contains)))) return false;
  }
  return true;
}

function missingRecipeGates(recipes = [], outcomes = []) {
  const successful = new Set((outcomes || []).filter(item => recipes.some(recipe => String(recipe.recipe_id) === String(item.recipe_id) && successfulFreshOutcome(recipe, item))).map(item => item.recipe_id));
  return (recipes || []).filter(recipe => !successful.has(recipe.recipe_id));
}

// A failed durable verification gate gets one bounded, fresh repair cycle. The
// callback is injected by Agent runtime and must use the normal canonical
// dispatcher; this module never invokes a handler or provider itself. A repair
// cycle is deliberately a re-check, not permission to mutate, and remains
// subject to the task's normal tool/verification/repair budgets.
async function runVerificationRepair({ task, recipes = [], outcomes = [], dispatch, recordOutcome, maxRecipes = 8 } = {}) {
  if (!task || typeof dispatch !== "function" || typeof recordOutcome !== "function") return { attempted: 0, outcomes: [], remaining: missingRecipeGates(recipes, outcomes) };
  const missing = missingRecipeGates(recipes, outcomes).slice(0, maxRecipes);
  const recorded = [];
  for (const recipe of missing) {
    const retryPolicy = recipe.retry_policy && typeof recipe.retry_policy === "object" ? recipe.retry_policy : {};
    const maxAttempts = Math.max(1, Math.min(3, Number(retryPolicy.max_attempts) || 1));
    let result = null;
    let text = "";
    let attempt = 0;
    do {
      attempt += 1;
      try { result = await dispatch(recipe.capability, recipe.arguments || {}, { timeoutMs: recipe.timeout_ms, verification: true }); }
      catch (error) { result = { isError: true, code: "verification_dispatch_error", content: [{ type: "text", text: String(error?.message || "verification dispatch failed") }] }; }
      text = String(result?.content?.map(item => item?.text || "").filter(Boolean).join(" ") || result?.error || result?.message || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2000);
      if (!result?.isError || attempt >= maxAttempts) break;
      const retryable = /timeout|temporar|unavailable|busy|network|econn|503/i.test(text) && !/approval|policy|forbidden|invalid|permission|security/i.test(text);
      if (!retryable) break;
      const backoff = Math.min(250, Math.max(0, Number(retryPolicy.backoff_ms) || 0));
      if (backoff) await new Promise(resolve => setTimeout(resolve, backoff));
    } while (attempt < maxAttempts);
    const ok = !result?.isError && expectationSatisfied(result, text, recipe.expected || {});
    const observationState = ok ? "successful" : (result?.isError ? "failed" : "contradictory");
    const outcome = recordOutcome({ recipe_id: recipe.recipe_id, task_id: task.task_id, evidence_ref: result?.receipt_ref || result?.operation_id || null, freshness_state: "fresh", independence_state: recipe.independent ? "independent" : "self_reported", observation_state: observationState, summary: text || (ok ? "verification repair recheck completed" : "verification repair recheck failed") });
    recorded.push(outcome);
  }
  const remaining = missingRecipeGates(recipes, [...outcomes, ...recorded]);
  return { attempted: missing.length, outcomes: recorded, remaining };
}

module.exports = { STATUSES, verifyTaskResult, outcomeIsFresh, successfulFreshOutcome, applyRecipeGates, applyReceiptGates, applyPlanGates, expectationSatisfied, missingRecipeGates, runVerificationRepair };
