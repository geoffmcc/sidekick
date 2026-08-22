"use strict";
const assert = require("assert");
const { recoverDurableAgentTasks } = require("../src/agent/recovery-scan");
const calls = [];
const tasks = new Map([[
  "task_1", { task_id: "task_1", state: "running", checkpoint: { version: 1, safe_boundary: "after_read", next_action: "resume" } }
]]);
const kernel = {
  recoverOrphanedExecutions: () => ({ scanned: 1, orphaned: ["exec_1"] }),
  getExecution: () => ({ execution_id: "exec_1", task_id: "task_1" }),
  getExecutionClaim: () => ({ checkpoint: { version: 1, safe_boundary: "after_read", next_action: "resume" } }),
};
const store = { getTask: id => tasks.get(id), updateTask: (id, patch, event) => { calls.push({ id, patch, event }); tasks.set(id, { ...tasks.get(id), ...patch }); } };
const result = recoverDurableAgentTasks({ platformKernel: kernel, taskStore: store, now: () => "2026-01-01T00:00:00.000Z" });
assert.deepStrictEqual(result.recovered, ["task_1"]);
assert.strictEqual(calls[0].event, "task.recovered");
assert.strictEqual(calls[0].patch.state, "interrupted");
console.log("Agent recovery scan: passed");
