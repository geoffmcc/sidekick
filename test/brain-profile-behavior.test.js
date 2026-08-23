"use strict";

const assert = require("assert");
const { runBrainTask } = require("../src/brain/brain");

async function runWithRounds(maxWorkRounds) {
  let plans = 0;
  const result = await runBrainTask({
    goal: "bounded profile behavior",
    classification: { requiresTools: true },
    agentTools: [{ name: "inspect", enabled: true }],
    toolContracts: [{ name: "inspect", version: 1, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, schema: { safeParse(value) { return { success: true, data: value }; } } }],
    plan: async () => { plans++; return { version: 1, goal: "bounded profile behavior", steps: [{ id: `inspect_${plans}`, type: "tool", tool: "inspect", arguments: {}, depends_on: [] }] }; },
    callTool: async () => ({ content: [{ type: "text", text: "current evidence" }] }),
    synthesize: async () => ({ answer: "should not synthesize without the completion gate" }),
    completionGate: async () => ({ complete: false, missing: ["required criterion"], reason: "criterion remains unverified" }),
    maxWorkRounds,
  });
  return { plans, result };
}

(async () => {
  const quick = await runWithRounds(1);
  const deep = await runWithRounds(3);
  assert.strictEqual(quick.plans, 2, "quick profile permits only one bounded revision round");
  assert.strictEqual(deep.plans, 4, "a larger profile envelope permits additional bounded revision rounds");
  assert.strictEqual(quick.result.state, "insufficient_evidence");
  assert.strictEqual(deep.result.state, "insufficient_evidence");
  console.log("Brain behavioral profile round limits: passed");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
