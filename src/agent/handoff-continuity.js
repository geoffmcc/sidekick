"use strict";

// Handoff checkpoints describe repository continuity; Agent checkpoints remain
// authoritative for execution recovery and approval continuation.
function createHandoffContinuity({ getTask, getHandoff, captureHandoffCheckpoint, workingDirectory = process.cwd(), intervalMs = 15000 }) {
  const lastCapture = new Map();

  function checkpointTask(taskId, { reason = "agent_loop_boundary", safeBoundary = "agent_loop_boundary" } = {}) {
    const task = getTask(taskId);
    if (!task || !task.handoff_id) return { captured: false, reason: "not_linked" };
    if (!getHandoff(task.handoff_id)) return { captured: false, reason: "handoff_not_found" };
    const now = Date.now();
    const prior = lastCapture.get(taskId);
    const boundary = String(safeBoundary || "agent_loop_boundary").slice(0, 80);
    const lifecycleBoundary = boundary !== "agent_loop_boundary" || /^task\./.test(String(reason));
    if (!lifecycleBoundary && prior && now - prior < intervalMs) return { captured: false, reason: "coalesced" };
    const result = captureHandoffCheckpoint(task.handoff_id, {
      working_directory: workingDirectory,
      actor: task.actor_id || "agent",
      source: "agent",
      metadata: {
        task_id: task.task_id,
        reason: String(reason || "agent_loop_boundary").slice(0, 120),
        safe_boundary: boundary,
        task_state: String(task.state || "").slice(0, 40),
        phase: String(task.phase || "").slice(0, 80),
        plan_revision: Number(task.current_plan_revision) || 0,
        milestone: task.current_milestone ? String(task.current_milestone).slice(0, 160) : null,
        work_package: task.active_work_package ? String(task.active_work_package).slice(0, 160) : null,
        checkpoint_updated_at: task.checkpoint?.updated_at || null,
      },
    });
    lastCapture.set(taskId, now);
    return { captured: true, handoff: result };
  }

  return { checkpointTask };
}

module.exports = { createHandoffContinuity };
