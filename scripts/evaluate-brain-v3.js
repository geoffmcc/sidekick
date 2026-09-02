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

function fixtureTool(name, mode) {
  if (mode === "unavailable") return { isError: true, code: "tool_unavailable", content: [{ type: "text", text: "configured capability unavailable" }] };
  if (name === "status") return { content: [{ type: "text", text: JSON.stringify({ status: "healthy", source: "deterministic-fixture" }) }] };
  return { content: [{ type: "text", text: "bounded fixture response" }] };
}

async function runScenario(scenario) {
  const events = [];
  const started = performance.now();
  let planCalls = 0;
  let criticCalls = 0;
  const result = await runBrainTask({
    goal: scenario.goal,
    classification: { requiresTools: scenario.requiresEvidence },
    agentTools: scenario.agentTools || tools,
    plan: async () => {
      planCalls++;
      if (scenario.plan === "malformed") return { version: 1, goal: scenario.goal, steps: [{ id: "bad", type: "tool", tool: "missing", arguments: {} }] };
      return scenario.plan === "respond" ? respondPlan : scenario.requiresEvidence ? statusPlan : directPlan;
    },
    critic: scenario.critic ? () => { criticCalls++; return criticCalls === 1 ? { disposition: "revise", findings: [{ code: "fixture_requires_review" }] } : { disposition: "accept", findings: [] }; } : null,
    callTool: async name => fixtureTool(name, scenario.toolMode),
    synthesize: async () => ({ answer: scenario.requiresEvidence ? "Status is healthy." : "A bounded direct answer." }),
    cancel: scenario.plan === "cancelled" ? { aborted: true } : { aborted: false },
    deadlineMs: scenario.plan === "timeout" ? Date.now() - 1 : undefined,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const elapsedMs = Math.round(performance.now() - started);
  const toolCalls = result.steps.filter(step => step.type === "tool").length;
  const replans = events.filter(event => event.type === "brain.replan").length;
  return {
    name: scenario.name,
    expected: scenario.expected,
    actual: result.state,
    passed: result.state === scenario.expected,
    evidence_count: result.evidenceCount || 0,
    plan_attempts: planCalls,
    critic_calls: criticCalls,
    tool_calls: toolCalls,
    replans,
    latency_ms: elapsedMs,
    operator_intervention: result.state === "waiting_for_approval" ? 1 : 0,
    unsupported_completion: result.state === "completed" && scenario.expected !== "completed" ? 1 : 0,
    error: result.error || null,
  };
}

async function main() {
  assert.strictEqual(validatePlan(statusPlan, { agentTools: tools }).ok, true);
  const scenarios = [
    { name: "direct-answer", goal: "answer directly", requiresEvidence: false, expected: "completed" },
    { name: "fresh-evidence", goal: "inspect status", requiresEvidence: true, expected: "completed" },
    { name: "missing-evidence-honesty", goal: "inspect status", requiresEvidence: true, plan: "respond", expected: "failed" },
    { name: "malformed-plan-rejection", goal: "inspect status", requiresEvidence: true, plan: "malformed", expected: "failed" },
    { name: "unavailable-tool", goal: "inspect status", requiresEvidence: true, toolMode: "unavailable", expected: "failed" },
    { name: "critic-replan", goal: "inspect status", requiresEvidence: true, critic: true, expected: "completed" },
    { name: "cancelled-before-dispatch", goal: "stop", requiresEvidence: false, plan: "cancelled", expected: "cancelled" },
    { name: "deadline-before-planning", goal: "stop", requiresEvidence: false, plan: "timeout", expected: "timed_out" },
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
    repeated_or_circular_calls: results.filter(result => result.tool_calls > 4).length,
    planning_revisions: sum("replans"),
    operator_intervention: sum("operator_intervention"),
    correct_tool_selection_rate: results.filter(result => result.name === "fresh-evidence" && result.tool_calls === 1).length,
    prerequisite_detection_rate: results.filter(result => ["malformed-plan-rejection", "unavailable-tool"].includes(result.name) && result.actual === "failed").length / 2,
    recovery_rate: results.filter(result => result.name === "critic-replan" && result.plan_attempts > 1 && result.actual === "completed").length,
    contradiction_detection: "not_evaluated",
    model_tokens: "not_available_for_fixture_backend",
    latency_ms: { p50: latencies[Math.floor(total / 2)], max: Math.max(...latencies) },
  };
  process.stdout.write(JSON.stringify({ schema: "sidekick.brain-v3-benchmark.v1", baseline: "deterministic-fixture", provider_integration: "not_evaluated", summary, scenarios: results }) + "\n");
  if (summary.failed) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
