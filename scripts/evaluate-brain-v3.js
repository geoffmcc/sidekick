"use strict";

// Deterministic Brain v3 regression benchmark. It measures the orchestrator's
// decisions with fixture seams; it does not claim provider or live Agent
// integration. Every scenario uses bounded fake model/tool responses.
const assert = require("assert");
const { performance } = require("perf_hooks");
const { runBrainTask } = require("../src/brain/brain");
const { validatePlan } = require("../src/brain/plan-validator");

const tools = [{ name: "status", enabled: true }, { name: "respond", enabled: true }];
const statusPlan = { version: 1, goal: "inspect status", steps: [{ id: "inspect", type: "tool", tool: "status", arguments: {}, purpose: "fresh evidence" }, { id: "answer", type: "synthesis", depends_on: ["inspect"] }] };
const directPlan = { version: 1, goal: "answer directly", steps: [{ id: "answer", type: "synthesis" }] };
const respondPlan = { version: 1, goal: "inspect status", steps: [{ id: "answer", type: "tool", tool: "respond", arguments: {}, purpose: "answer" }, { id: "synthesis", type: "synthesis", depends_on: ["answer"] }] };
const partialPlan = { version: 1, goal: "inspect status twice", steps: [{ id: "first", type: "tool", tool: "status", arguments: {} }, { id: "second", type: "tool", tool: "status", arguments: {} }, { id: "answer", type: "synthesis", depends_on: ["first", "second"] }] };
const conflictPlan = { version: 1, goal: "inspect status", steps: [{ id: "conflict", type: "tool", tool: "status", arguments: {} }, { id: "answer", type: "synthesis", depends_on: ["conflict"] }] };
const excessivePlan = { version: 1, goal: "inspect status", steps: ["one", "two", "three", "four", "five", "six"].map(id => ({ id, type: "tool", tool: "status", arguments: {} })).concat([{ id: "answer", type: "synthesis" }]) };

function fixtureTool(name, mode, callNumber) {
  if (mode === "unavailable") return { isError: true, code: "tool_unavailable", content: [{ type: "text", text: "configured capability unavailable" }] };
  if (mode === "authority_denied") return { isError: true, code: "policy_denied", content: [{ type: "text", text: "authority denied by deterministic fixture policy" }] };
  if (mode === "partial" && callNumber === 2) return { isError: true, code: "tool_error", content: [{ type: "text", text: "second inspection failed after first inspection completed" }] };
  if (mode === "conflicting") return { content: [{ type: "text", text: JSON.stringify({ status: callNumber === 1 ? "healthy" : "degraded", evidence: { completeness: "conflicted", conflict: true, reason: "two fixture observations disagree" } }) }] };
  if (name === "status") return { content: [{ type: "text", text: JSON.stringify({ status: "healthy", source: "deterministic-fixture" }) }] };
  return { content: [{ type: "text", text: "bounded fixture response" }] };
}

async function runScenario(scenario) {
  const events = [];
  const started = performance.now();
  let planCalls = 0;
  let criticCalls = 0;
  let toolCallNumber = 0;
  let recalledMemory = [];
  const result = await runBrainTask({
    goal: scenario.goal,
    classification: { requiresTools: scenario.requiresEvidence },
    agentTools: scenario.agentTools || tools,
    recallMemory: scenario.memory ? async () => {
      recalledMemory = scenario.memory;
      return scenario.memory;
    } : null,
    plan: async () => {
      planCalls++;
      if (scenario.plan === "ambiguous") throw new Error("ambiguous goal requires clarification before planning");
      if (scenario.plan === "malformed") return { version: 1, goal: scenario.goal, steps: [{ id: "bad", type: "tool", tool: "missing", arguments: {} }] };
      if (scenario.plan === "partial") return partialPlan;
      if (scenario.plan === "conflicting") return conflictPlan;
      if (scenario.plan === "excessive") return excessivePlan;
      return scenario.plan === "respond" ? respondPlan : scenario.requiresEvidence ? statusPlan : directPlan;
    },
    critic: scenario.critic ? () => { criticCalls++; return criticCalls === 1 ? { disposition: "revise", findings: [{ code: "fixture_requires_review" }] } : { disposition: "accept", findings: [] }; } : null,
    callTool: async name => fixtureTool(name, scenario.toolMode, ++toolCallNumber),
    synthesize: async () => scenario.plan === "conflicting"
      ? { answer: "" }
      : { answer: scenario.plan === "false-belief" ? "Fresh evidence corrects the stale initial belief." : scenario.requiresEvidence ? "Status is healthy." : "A bounded direct answer." },
    cancel: scenario.plan === "cancelled" ? { aborted: true } : { aborted: false },
    deadlineMs: scenario.plan === "timeout" ? Date.now() - 1 : undefined,
    maxWorkRounds: scenario.plan === "conflicting" ? 1 : undefined,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const elapsedMs = Math.round(performance.now() - started);
  const toolCalls = result.steps.filter(step => step.type === "tool").length;
  const successfulToolCalls = result.steps.filter(step => step.type === "tool" && step.ok === true).length;
  const replans = events.filter(event => event.type === "brain.replan").length;
  const failureKinds = events.filter(event => event.type === "brain.step_repair_guidance").map(event => event.payload.failure_kind);
  return {
    name: scenario.name,
    coverage: scenario.coverage,
    expected: scenario.expected,
    actual: result.state,
    passed: result.state === scenario.expected,
    evidence_count: result.evidenceCount || successfulToolCalls,
    successful_tool_calls: successfulToolCalls,
    memory_count: recalledMemory.length,
    plan_attempts: planCalls,
    critic_calls: criticCalls,
    tool_calls: toolCalls,
    replans,
    latency_ms: elapsedMs,
    failure_kinds: failureKinds,
    failure_code: result.failure_code || null,
    excessive_or_circular: toolCalls > 4 || failureKinds.includes("repeated_tool_call") || result.failure_code === "repeated_tool_call",
    operator_intervention: result.state === "waiting_for_approval" ? 1 : 0,
    unsupported_completion: result.state === "completed" && scenario.expected !== "completed" ? 1 : 0,
    error: result.error || null,
  };
}

async function main() {
  assert.strictEqual(validatePlan(statusPlan, { agentTools: tools }).ok, true);
  const scenarios = [
    { name: "direct-answer", coverage: "direct_goal", goal: "answer directly", requiresEvidence: false, expected: "completed" },
    { name: "fresh-evidence", coverage: "fresh_evidence", goal: "inspect status", requiresEvidence: true, expected: "completed" },
    { name: "missing-evidence-honesty", coverage: "missing_evidence", goal: "inspect status", requiresEvidence: true, plan: "respond", expected: "failed" },
    { name: "malformed-plan-rejection", coverage: "plan_validation", goal: "inspect status", requiresEvidence: true, plan: "malformed", expected: "failed" },
    { name: "unavailable-tool", coverage: "tool_availability", goal: "inspect status", requiresEvidence: true, toolMode: "unavailable", expected: "failed" },
    { name: "critic-replan", coverage: "critic_recovery", goal: "inspect status", requiresEvidence: true, critic: true, expected: "completed" },
    { name: "cancelled-before-dispatch", coverage: "cancellation", goal: "stop", requiresEvidence: false, plan: "cancelled", expected: "cancelled" },
    { name: "deadline-before-planning", coverage: "deadline", goal: "stop", requiresEvidence: false, plan: "timeout", expected: "timed_out" },
    { name: "ambiguous-goal-fails-closed", coverage: "ambiguous_goal", goal: "make it better", requiresEvidence: false, plan: "ambiguous", expected: "failed" },
    { name: "authority-denial", coverage: "authority_denial", goal: "inspect status", requiresEvidence: true, toolMode: "authority_denied", expected: "failed" },
    { name: "partial-completion-is-not-success", coverage: "partial_completion", goal: "inspect status twice", requiresEvidence: true, plan: "partial", toolMode: "partial", expected: "failed" },
    { name: "conflicting-evidence-not-evaluated", coverage: "conflicting_evidence", goal: "inspect status", requiresEvidence: true, plan: "conflicting", toolMode: "conflicting", expected: "failed" },
    { name: "false-initial-belief-corrected", coverage: "false_initial_belief", goal: "inspect status", requiresEvidence: true, plan: "false-belief", memory: [{ claim: "status is healthy", source: "stale-fixture", freshness: "stale" }], expected: "completed" },
    { name: "memory-selection-not-evaluated", coverage: "memory_selection", goal: "inspect status", requiresEvidence: true, memory: Array.from({ length: 10 }, (_, index) => ({ claim: `memory-${index + 1}`, source: "deterministic-fixture" })), expected: "completed" },
    { name: "excessive-circular-tool-use", coverage: "excessive_circular_tools", goal: "inspect status", requiresEvidence: true, plan: "excessive", expected: "failed" },
  ];
  const results = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario));
  const total = results.length;
  const passed = results.filter(result => result.passed).length;
  const sum = key => results.reduce((value, result) => value + Number(result[key] || 0), 0);
  const latencies = results.map(result => result.latency_ms).sort((a, b) => a - b);
  const summary = {
    total, passed, failed: total - passed,
    completion_rate: passed / total,
    verified_completion_rate: results.filter(result => result.actual === "completed" && result.evidence_count > 0).length / total,
    unsupported_completion_rate: sum("unsupported_completion") / total,
    unnecessary_tool_calls: results.filter(result => result.expected !== "completed" && result.tool_calls === 0).length,
    repeated_or_circular_calls: results.filter(result => result.excessive_or_circular).length,
    excessive_or_circular_tool_use: results.filter(result => result.coverage === "excessive_circular_tools" && result.excessive_or_circular).length,
    planning_revisions: sum("replans"),
    operator_intervention: sum("operator_intervention"),
    correct_tool_selection_rate: results.filter(result => result.name === "fresh-evidence" && result.tool_calls === 1).length,
    prerequisite_detection_rate: results.filter(result => ["malformed-plan-rejection", "unavailable-tool"].includes(result.name) && result.actual === "failed").length / 2,
    recovery_rate: results.filter(result => result.name === "critic-replan" && result.plan_attempts > 1 && result.actual === "completed").length,
    authority_denial_rate: results.filter(result => result.coverage === "authority_denial" && result.failure_kinds.includes("policy_denied")).length,
    partial_completion_observed: results.filter(result => result.coverage === "partial_completion" && result.actual === "failed" && result.evidence_count > 0).length,
    conflict_handling: "not_evaluated",
    false_initial_belief_path: results.some(result => result.coverage === "false_initial_belief" && result.memory_count === 1 && result.evidence_count > 0) ? "fixture_memory_and_fresh_evidence_exercised" : "not_evaluated",
    memory_selection: "not_evaluated",
    model_tokens: "not_available_for_fixture_backend",
    latency_ms: { p50: latencies[Math.floor(total / 2)], max: Math.max(...latencies) },
  };
  process.stdout.write(JSON.stringify({ schema: "sidekick.brain-v3-benchmark.v1", baseline: "deterministic-fixture", provider_integration: "not_evaluated", summary, scenarios: results }) + "\n");
  if (summary.failed) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
