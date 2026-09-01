"use strict";

const assert = require("assert");
const { runBrainTask } = require("../src/brain/brain");
const { validatePlan } = require("../src/brain/plan-validator");

const tools = [{ name: "status", enabled: true }, { name: "respond", enabled: true }];
const plan = requiresEvidence => ({ version: 1, goal: requiresEvidence ? "inspect status" : "answer directly", steps: requiresEvidence
  ? [{ id: "inspect", type: "tool", tool: "status", arguments: {}, purpose: "fresh evidence" }, { id: "answer", type: "synthesis", depends_on: ["inspect"] }]
  : [{ id: "answer", type: "synthesis" }] });
async function scenario(name, requiresEvidence) {
  const candidate = plan(requiresEvidence);
  assert.strictEqual(validatePlan(candidate, { agentTools: tools }).ok, true);
  const result = await runBrainTask({ goal: candidate.goal, classification: { requiresTools: requiresEvidence }, agentTools: tools, plan: async () => candidate, callTool: async () => ({ content: [{ type: "text", text: "status: healthy" }] }), synthesize: async () => ({ answer: requiresEvidence ? "Status is healthy." : "A bounded direct answer." }) });
  assert.strictEqual(result.state, "completed");
  return { name, state: result.state, evidence: result.evidenceCount || 0 };
}
(async () => {
  const results = [await scenario("direct-answer", false), await scenario("current-state", true)];
  process.stdout.write(JSON.stringify({ version: 3, scenarios: results }) + "\n");
})().catch(error => { process.stderr.write(String(error.message || error) + "\n"); process.exitCode = 1; });
