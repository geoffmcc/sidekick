"use strict";
process.env.NODE_ENV = "test";
const assert = require("assert");
const { createTask } = require("../src/agent/task-model");

const task = createTask({
  task_id: "agt_goal_contract",
  objective: "Inspect the workspace and verify the expected file exists",
  goal: {
    normalized_objective: "Inspect the governed workspace and verify one file",
    success_criteria: ["expected file exists"],
    verification_requirements: ["fresh independent file inspection"],
    requires_live_evidence: true,
    stopping_conditions: ["budget exhausted"],
  },
  profile: "standard",
  continuation_reference: { kind: "verify", reference: "evidence:ev_123" },
});
assert.strictEqual(task.goal.normalized_objective, "Inspect the governed workspace and verify one file");
assert.deepStrictEqual(task.goal.success_criteria, ["expected file exists"]);
assert.strictEqual(task.goal.requires_live_evidence, true);
assert.strictEqual(task.requirements[0].text, "expected file exists");
assert.deepStrictEqual(task.continuation.parent_reference, { kind: "verify", reference: "evidence:ev_123" });
assert.throws(() => createTask({ task_id: "agt_bad_goal", objective: "x", goal: { success_criteria: ["x".repeat(501)] }, profile: "quick" }), /goal item/);
console.log("Agent goal contract: passed");
