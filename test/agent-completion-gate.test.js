"use strict";
const assert = require("assert");
const { runToolLoop } = require("../src/agent-loop");
const { runBrainTask } = require("../src/brain/brain");

const defs = [{ name: "inspect", enabled: true }, { name: "respond", enabled: true }];

(async () => {
  let calls = 0;
  const simple = await runToolLoop({
    history: [{ role: "user", content: "Find the service status" }],
    callLLM: async () => ({ response: calls++ === 0 ? JSON.stringify({ tool: "inspect", arguments: {} }) : JSON.stringify({ done: true, result: "confirmed" }) }),
    callTool: async () => ({ content: [{ text: "status=ok" }] }),
    getToolDefs: () => defs,
    requireEvidence: true,
  });
  assert.strictEqual(simple.status, "completed", "a simple evidenced task completes without unnecessary rounds");

  let partialCalls = 0;
  let gateCalls = 0;
  const complex = await runToolLoop({
    history: [{ role: "user", content: "Audit architecture and verify approval continuation" }],
    callLLM: async () => ({ response: partialCalls++ === 0
      ? JSON.stringify({ tool: "inspect", arguments: {} })
      : partialCalls === 2
        ? JSON.stringify({ done: true, result: "partial" })
        : JSON.stringify({ done: true, result: "complete" }) }),
    callTool: async () => ({ content: [{ text: "evidence" }] }),
    getToolDefs: () => defs,
    requireEvidence: true,
    completionGate: async () => ({ complete: gateCalls++ > 0, missing: gateCalls ? [] : ["approval continuation"] }),
  });
  assert.strictEqual(complex.status, "completed", "complex task eventually completes through the gate");
  assert.ok(gateCalls >= 2, "partial completion is rejected before synthesis");

  let planCalls = 0;
  let brainCalls = 0;
  const brain = await runBrainTask({
    goal: "Inspect architecture and verify continuation",
    classification: { requiresTools: true },
    agentTools: [{ name: "inspect", enabled: true }],
    plan: async () => ({ version: 1, goal: "task", steps: [{ id: `inspect-${++planCalls}`, type: "tool", tool: "inspect", arguments: {} }, { id: `synth-${planCalls}`, type: "synthesis", depends_on: [`inspect-${planCalls}`] }] }),
    callTool: async () => { brainCalls++; return { content: [{ text: "evidence" }] }; },
    completionGate: async () => ({ complete: planCalls > 1, missing: ["continuation"] }),
    synthesize: async () => ({ answer: "verified" }),
  });
  assert.strictEqual(brain.status, "completed", "Brain replans after a partial validated plan");
  assert.strictEqual(planCalls, 2);
  assert.strictEqual(brainCalls, 2);
  console.log("Agent completion-gate tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
