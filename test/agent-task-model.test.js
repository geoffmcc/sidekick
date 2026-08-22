"use strict";
const assert = require("assert");
const { createTask, normalizeGoal, normalizeWorkspaceRef, transition, actionFingerprint, assertCheckpoint, validateResult, budgetExceeded } = require("../src/agent/task-model");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { console.error(`  ✗ ${name}: ${error.message}`); process.exitCode = 1; } }
test("normalizes broad goals into bounded explicit criteria", () => { const task = createTask({ task_id: "agt_test01", objective: "Investigate service health", profile: "deep", goal: { success_criteria: ["current status is collected", "contradictions are reported"], read_only: true } }); assert.strictEqual(task.goal.read_only, true); assert.strictEqual(task.requirements.length, 2); assert.strictEqual(task.budget.tool_calls, 500); });
test("rejects authority broadening and oversized criteria", () => { assert.throws(() => normalizeGoal("x", { authority_boundary: "x".repeat(1001) })); assert.throws(() => normalizeGoal("x", { success_criteria: Array.from({ length: 51 }, () => "x") })); });
test("enforces explicit state transitions", () => { const task = createTask({ task_id: "agt_test02", objective: "x" }); assert.strictEqual(transition(task, "planning").state, "planning"); assert.throws(() => transition(task, "completed")); });
test("safe checkpoints require a boundary and next action", () => { const task = createTask({ task_id: "agt_test03", objective: "x" }); assert.throws(() => assertCheckpoint(task, {})); assert.strictEqual(assertCheckpoint(task, { version: 1, safe_boundary: "after_read", next_action: "plan" }).safe_boundary, "after_read"); });
test("results are structured and status-bounded", () => { assert.strictEqual(validateResult({ summary: "ok", status: "verified" }).version, 1); assert.throws(() => validateResult({ status: "complete" })); });
test("fingerprints are stable and budgets are enforced", () => { assert.strictEqual(actionFingerprint("health", { b: 2, a: { z: 1, y: 2 } }), actionFingerprint("health", { a: { y: 2, z: 1 }, b: 2 })); const task = createTask({ task_id: "agt_test04", objective: "x" }); task.usage.tool_calls = task.budget.tool_calls; assert.strictEqual(budgetExceeded(task, "tool_calls"), true); });
test("workspace references are governed and bounded", () => { assert.strictEqual(normalizeWorkspaceRef("workspace:local_1"), "workspace:local_1"); assert.throws(() => normalizeWorkspaceRef("../../etc/passwd")); });
console.log(`Agent task model: ${passed} passed`);
