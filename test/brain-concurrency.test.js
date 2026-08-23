"use strict";

const assert = require("assert");
const { executePlanSteps, newAccumulator } = require("../src/brain/brain");

const descriptor = (name) => ({
  name,
  version: 1,
  enabled: true,
  risk: "low",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  schema: { safeParse(value) { return { success: value && value.action === "status", data: value }; } },
});

(async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const workPackages = [];
  const acc = newAccumulator();
  const outcome = await executePlanSteps({
    plan: { steps: [
      { id: "a", type: "tool", tool: "inspect_a", arguments: { action: "status" }, depends_on: [] },
      { id: "b", type: "tool", tool: "inspect_b", arguments: { action: "status" }, depends_on: [] },
      { id: "c", type: "tool", tool: "inspect_c", arguments: { action: "status" }, depends_on: [] },
    ] },
    acc,
    toolContracts: [descriptor("inspect_a"), descriptor("inspect_b"), descriptor("inspect_c")],
    agentTools: [{ name: "inspect_a" }, { name: "inspect_b" }, { name: "inspect_c" }],
    concurrencyLimit: 2,
    workPackageHooks: {
      start: async (step) => { const handle = { package_id: `pkg-${step.id}` }; workPackages.push({ id: handle.package_id, state: "running" }); return handle; },
      finish: async (handle, state) => { const item = workPackages.find(pkg => pkg.id === handle.package_id); item.state = state; },
    },
    callTool: async (name) => {
      active++;
      peak = Math.max(peak, active);
      calls.push(name);
      await new Promise(resolve => setTimeout(resolve, name === "inspect_a" ? 20 : 5));
      active--;
      return { content: [{ type: "text", text: `${name}:ok` }] };
    },
  });
  assert.strictEqual(outcome.status, "completed");
  assert.strictEqual(peak, 2, "the durable concurrency limit bounds overlapping reads");
  assert.deepStrictEqual(acc.steps.map(step => step.id), ["a", "b", "c"], "evidence joins in deterministic plan order");
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(workPackages, [{ id: "pkg-a", state: "completed" }, { id: "pkg-b", state: "completed" }], "concurrent reads receive durable work-package lifecycle hooks");
  console.log("Brain bounded read-only concurrency: passed");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
