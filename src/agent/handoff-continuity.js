"use strict";

// Handoff checkpoints describe repository continuity; Agent checkpoints remain
// authoritative for execution recovery and approval continuation.
function createHandoffContinuity({ getTask, getHandoff, captureHandoffCheckpoint, saveHandoff, transitionHandoff, workingDirectory = process.cwd(), intervalMs = 15000 }) {
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
    const taskDirectory = task.working_directory || task.repository || workingDirectory;
    let handoff = getHandoff(task.handoff_id);
    const taskState = String(task.state || "active");
    const terminal = new Set(["completed", "partial", "failed", "cancelled", "timed_out"]);
    if (lifecycleBoundary && typeof saveHandoff === "function") {
      const packet = handoff.packet || {};
      const resultEvidence = Array.isArray(task.result?.evidence_refs) ? task.result.evidence_refs.map((item, index) => typeof item === "object" ? item : ({ type: "agent_result", label: `Agent result evidence ${index + 1}`, status: taskState === "completed" ? "passed" : "recorded", reference: String(item), observed_at: new Date().toISOString() })) : [];
      const completed = taskState === "completed";
      handoff = saveHandoff({
        id: handoff.id,
        content: handoff.content,
        packet: {
          ...packet,
          objective: packet.objective || task.objective,
          summary: task.result?.summary || packet.summary || task.stopping_reason || task.objective,
          status: completed ? "completed" : "active",
          current_state: task.phase || taskState,
          next_step: task.next_action || (completed ? null : "Continue from the latest safe checkpoint"),
          completed_steps: Array.isArray(packet.completed_steps) ? packet.completed_steps : (task.continuation?.completed_operations || []),
          acceptance_criteria: Array.isArray(packet.acceptance_criteria) && packet.acceptance_criteria.length ? packet.acceptance_criteria : (task.goal?.success_criteria || (completed ? ["Agent task reached verified completion"] : [])),
          evidence: [...(Array.isArray(packet.evidence) ? packet.evidence : []), ...resultEvidence],
          provenance: { ...(packet.provenance || {}), task_id: task.task_id, working_directory: packet.provenance?.working_directory || taskDirectory },
        },
        extraction_state: "pending",
        expectedVersion: handoff.version,
      });
    }
    const result = captureHandoffCheckpoint(task.handoff_id, {
      working_directory: handoff.packet?.provenance?.working_directory || taskDirectory,
      expectedVersion: handoff.version,
      actor: task.actor_id || "agent",
      source: "agent",
      metadata: {
        task_id: task.task_id,
        reason: String(reason || "agent_loop_boundary").slice(0, 120),
        safe_boundary: boundary,
         task_state: taskState.slice(0, 40),
        phase: String(task.phase || "").slice(0, 80),
        plan_revision: Number(task.current_plan_revision) || 0,
        milestone: task.current_milestone ? String(task.current_milestone).slice(0, 160) : null,
        work_package: task.active_work_package ? String(task.active_work_package).slice(0, 160) : null,
        checkpoint_updated_at: task.checkpoint?.updated_at || null,
      },
    });
    if (lifecycleBoundary && typeof transitionHandoff === "function") {
      const target = taskState === "completed" ? "completed" : "active";
      if (handoff.lifecycle_state === "draft" || (target === "completed" && handoff.lifecycle_state === "active")) {
        transitionHandoff(task.handoff_id, target, { expectedVersion: result.version, actor: task.actor_id || "agent", source: "agent", reason: boundary });
      }
    }
    lastCapture.set(taskId, now);
    return { captured: true, handoff: result };
  }

  return { checkpointTask };
}

module.exports = { createHandoffContinuity };
