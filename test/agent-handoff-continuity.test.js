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
let savedPacket = null;
let evidenceRefreshes = 0;
const continuity = createHandoffContinuity({
  getTask: () => task,
  getHandoff: () => handoff,
  authorizeHandoffWrite: () => true,
  captureHandoffCheckpoint: (id, args) => {
    captures += 1;
    assert.strictEqual(id, task.handoff_id);
    assert.strictEqual(args.source, "agent");
    assert.strictEqual(args.metadata.task_id, task.task_id);
    assert.strictEqual(args.metadata.plan_revision, 2);
    assert.strictEqual(args.metadata.work, undefined);
    return { id, version: 1 };
  },
  saveHandoff: input => {
    savedPacket = input.packet;
    return { id: input.id, version: 1, content: input.content, packet: input.packet, lifecycle_state: "draft" };
  },
  refreshHandoffEvidence: () => { evidenceRefreshes += 1; },
  listPlans: () => [{ revision: 2, plan: { objective: "complete the task", steps: [{ id: "step_1" }, { id: "step_2" }] } }],
  intervalMs: 60_000,
});

try {
  assert.strictEqual(continuity.checkpointTask(task.task_id).captured, true);
  assert.strictEqual(continuity.checkpointTask(task.task_id).reason, "coalesced");
  assert.strictEqual(continuity.checkpointTask(task.task_id, { reason: "task.paused", safeBoundary: "pause_boundary" }).captured, true);
  assert.strictEqual(captures, 2);
  assert.deepStrictEqual(savedPacket.plan.steps.map(step => step.id), ["step_1", "step_2"], "handoff carries the full remaining task plan, not merely the immediate action");
  assert.deepStrictEqual(savedPacket.remaining_steps.map(step => step.id), ["step_1", "step_2"], "handoff explicitly carries work remaining after restart");
  assert.strictEqual(savedPacket.provenance.task_id, task.task_id, "handoff snapshot is tied to its durable task");
  assert.ok(savedPacket.evidence.some(item => item.type === "continuity_checkpoint"), "each automatic snapshot records fresh continuity evidence");
  assert.strictEqual(evidenceRefreshes, 2, "automatic snapshots refresh their evidence state");
  const deniedContinuity = createHandoffContinuity({
    getTask: () => task,
    getHandoff: () => handoff,
    authorizeHandoffWrite: () => false,
    saveHandoff: () => { throw new Error("denied handoff must not be saved"); },
    captureHandoffCheckpoint: () => { throw new Error("denied handoff must not be checkpointed"); },
  });
  assert.throws(() => deniedContinuity.checkpointTask(task.task_id), /Current authority does not permit updating the linked handoff/,
    "revoked or missing current authority stops continuity writes before persistence");

  let currentWriteAuthority = true;
  let guardedSaves = 0;
  const revocationContinuity = createHandoffContinuity({
    getTask: () => task,
    getHandoff: () => handoff,
    authorizeHandoffWrite: () => currentWriteAuthority,
    saveHandoff: input => { guardedSaves += 1; return { id: input.id, version: guardedSaves, content: input.content, packet: input.packet, lifecycle_state: "active" }; },
    captureHandoffCheckpoint: () => ({ id: handoff.id, version: guardedSaves }),
  });
  assert.strictEqual(revocationContinuity.checkpointTask(task.task_id).captured, true);
  currentWriteAuthority = false;
  const savesAtRevocation = guardedSaves;
  assert.throws(() => revocationContinuity.checkpointTask(task.task_id, { reason: "task.recovered", safeBoundary: "recovery_boundary" }),
    /Current authority does not permit updating the linked handoff/,
    "a later checkpoint rechecks authority after it is revoked");
  assert.strictEqual(guardedSaves, savesAtRevocation, "revoked authority prevents subsequent continuity mutation");
  console.log("Agent handoff continuity: passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
