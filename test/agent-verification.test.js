"use strict";
const assert = require("assert");
const { verifyTaskResult, applyRecipeGates, applyReceiptGates, applyPlanGates, runVerificationRepair } = require("../src/agent/verification");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { console.error(`  ✗ ${name}: ${error.message}`); process.exitCode = 1; } }
test("requires current evidence for live tasks", () => { assert.strictEqual(verifyTaskResult({ requires_live_evidence: true, result: "ok" }).status, "unable_to_verify"); });
test("does not accept result text as evidence", () => { assert.strictEqual(verifyTaskResult({ criteria: ["healthy"], result: "healthy" }).status, "unable_to_verify"); });
test("marks criteria with attributable evidence", () => { const out = verifyTaskResult({ criteria: ["healthy"], result: "Service is healthy", evidence: [{ tool: "health", id: "ev1", ok: true, text: "healthy" }] }); assert.strictEqual(out.status, "verified"); assert.strictEqual(out.criteria_covered, 1); });
test("contradiction and terminal conditions remain honest", () => { assert.strictEqual(verifyTaskResult({ result: "x", evidence: [{ tool: "health", id: "e", ok: false, text: "error unavailable" }] }).status, "contradicted"); assert.strictEqual(verifyTaskResult({ terminal_state: "timed_out", result: "x" }).status, "budget_exhausted"); });
test("durable recipe gates prevent verification without fresh successful outcomes", () => { const base = verifyTaskResult({ criteria: ["healthy"], result: "healthy", evidence: [{ tool: "health", id: "ev1", ok: true, text: "healthy" }] }); const recipe = [{ recipe_id: "recipe-1", requirement_id: "health" }]; assert.strictEqual(applyRecipeGates(base, recipe, []).status, "unable_to_verify"); assert.strictEqual(applyRecipeGates(base, recipe, [{ recipe_id: "recipe-1", observation_state: "successful", freshness_state: "fresh", independence_state: "independent" }]).status, "verified"); });
test("self-reported outcomes cannot satisfy an independent recipe gate", () => { const result = applyRecipeGates({ status: "verified" }, [{ recipe_id: "recipe-2", requirement_id: "r2" }], [{ recipe_id: "recipe-2", observation_state: "successful", freshness_state: "fresh", independence_state: "self_reported" }]); assert.strictEqual(result.status, "unable_to_verify"); });
test("persisted evidence expires at the recipe freshness boundary", () => { const result = applyRecipeGates({ status: "verified" }, [{ recipe_id: "recipe-expiring", requirement_id: "r-expiring", freshness_ms: 1000 }], [{ recipe_id: "recipe-expiring", observation_state: "successful", freshness_state: "fresh", independence_state: "independent", observed_at: new Date(Date.now() - 2000).toISOString() }]); assert.strictEqual(result.status, "unable_to_verify"); });
test("mutating receipts without a governed recipe cannot become verified", () => { const result = applyReceiptGates({ status: "verified" }, [{ receipt_id: "receipt-mutation", effect_class: "workspace_reversible", outcome_state: "finalized", verification_recipe_ref: null }]); assert.strictEqual(result.status, "unable_to_verify"); assert.deepStrictEqual(result.missing_receipt_gates, ["receipt-mutation"]); });
test("hierarchical milestones require fresh independent gate evidence", () => { const plan = [{ milestones: [{ id: "milestone-1", verification_gate_ids: ["gate-1"] }], verification_gates: [{ id: "gate-1", recipe_id: "recipe-1" }] }]; const missing = applyPlanGates({ status: "verified" }, plan, []); assert.strictEqual(missing.status, "unable_to_verify"); assert.deepStrictEqual(missing.missing_milestones, ["milestone-1"]); const satisfied = applyPlanGates({ status: "verified" }, plan, [{ recipe_id: "recipe-1", observation_state: "successful", freshness_state: "fresh", independence_state: "independent" }]); assert.strictEqual(satisfied.status, "verified"); });
console.log(`Agent verification: ${passed} passed`);

(async () => {
  let calls = 0;
  const recorded = [];
  const repaired = await runVerificationRepair({
    task: { task_id: "agt-verification-repair" },
    recipes: [{ recipe_id: "recipe-recheck", capability: "health", arguments: {}, expected: { text_includes: "healthy" }, independent: true, retry_policy: { max_attempts: 1 } }],
    outcomes: [],
    dispatch: async () => { calls++; return { content: [{ text: "healthy" }] }; },
    recordOutcome: outcome => { recorded.push(outcome); return { ...outcome, outcome_id: "outcome-1" }; },
  });
  assert.strictEqual(calls, 1, "a missing recipe receives one bounded canonical recheck");
  assert.strictEqual(recorded[0].observation_state, "successful");
  assert.strictEqual(repaired.remaining.length, 0);
  console.log("  ✓ failed verification triggers one bounded fresh recheck");
})().catch(error => { console.error(error); process.exitCode = 1; });
