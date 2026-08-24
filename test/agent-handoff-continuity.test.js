"use strict";
const assert = require("assert");
const { createHandoffContinuity } = require("../src/agent/handoff-continuity");

let captures = 0;
const task = {
  task_id: "agt_cont01",
  handoff_id: "handoff_cont01",
  actor_id: "principal:test",
  state: "running",
  phase: "execution",
  current_plan_revision: 2,
  current_milestone: "inspect",
  active_work_package: "package_1",
  checkpoint: { updated_at: "2026-08-24T00:00:00.000Z" },
};
const handoff = { id: task.handoff_id };
const continuity = createHandoffContinuity({
  getTask: () => task,
  getHandoff: () => handoff,
  captureHandoffCheckpoint: (id, args) => {
    captures += 1;
    assert.strictEqual(id, task.handoff_id);
    assert.strictEqual(args.source, "agent");
    assert.strictEqual(args.metadata.task_id, task.task_id);
    assert.strictEqual(args.metadata.plan_revision, 2);
    assert.strictEqual(args.metadata.work, undefined);
    return { id };
  },
  intervalMs: 60_000,
});

try {
  assert.strictEqual(continuity.checkpointTask(task.task_id).captured, true);
  assert.strictEqual(continuity.checkpointTask(task.task_id).reason, "coalesced");
  assert.strictEqual(continuity.checkpointTask(task.task_id, { reason: "task.paused", safeBoundary: "pause_boundary" }).captured, true);
  assert.strictEqual(captures, 2);
  console.log("Agent handoff continuity: passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
