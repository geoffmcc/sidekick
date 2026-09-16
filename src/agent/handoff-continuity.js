"use strict";

// Handoff checkpoints describe repository continuity; Agent checkpoints remain
// authoritative for execution recovery and approval continuation.
function createHandoffContinuity({ getTask, getHandoff, captureHandoffCheckpoint, saveHandoff, transitionHandoff, refreshHandoffEvidence = null, listPlans = null, workingDirectory = process.cwd(), intervalMs = 15000 }) {
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
    if (typeof saveHandoff === "function") {
      const packet = handoff.packet || {};
      const resultEvidence = Array.isArray(task.result?.evidence_refs) ? task.result.evidence_refs.map((item, index) => typeof item === "object" ? item : ({ type: "agent_result", label: `Agent result evidence ${index + 1}`, status: taskState === "completed" ? "passed" : "recorded", reference: String(item), observed_at: new Date().toISOString() })) : [];
      const completed = taskState === "completed";
      const completedOperations = Array.isArray(task.continuation?.completed_operations) ? task.continuation.completed_operations : [];
      const ambiguousOperations = Array.isArray(task.continuation?.ambiguous_operations) ? task.continuation.ambiguous_operations : [];
      const plans = typeof listPlans === "function" ? listPlans(task.task_id) : [];
      const currentPlan = Array.isArray(plans) ? (plans.find(plan => Number(plan.revision) === Number(task.current_plan_revision)) || plans[0] || null) : null;
      const planSteps = Array.isArray(currentPlan?.plan?.steps) ? currentPlan.plan.steps : [];
      const completedSteps = [
        ...(Array.isArray(packet.completed_steps) ? packet.completed_steps : []),
        ...completedOperations,
      ].filter(Boolean).slice(-200);
      const remainingSteps = planSteps.filter(step => !["completed", "done", "verified", "skipped"].includes(String(step?.status || step?.state || "").toLowerCase())).slice(0, 200);
      const continuityEvidence = { type: "continuity_checkpoint", label: "Durable Agent continuity snapshot", status: "verified", observed_at: new Date().toISOString(), task_id: task.task_id };
      const blockers = [
        ...(Array.isArray(packet.blockers) ? packet.blockers : []),
        ...(task.stopping_reason ? [task.stopping_reason] : []),
        ...ambiguousOperations.map(item => item.reason || `Verify ambiguous ${item.capability || "operation"}`),
      ].filter(Boolean).map(String).slice(-50);
      const artifacts = [
        ...(Array.isArray(packet.artifacts) ? packet.artifacts : []),
        ...(Array.isArray(task.result?.artifacts) ? task.result.artifacts : []),
        ...(Array.isArray(task.artifact_refs) ? task.artifact_refs : []),
      ].filter(item => item && typeof item === "object").slice(-100);
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
          completed_steps: completedSteps,
          remaining_steps: remainingSteps,
          acceptance_criteria: Array.isArray(packet.acceptance_criteria) && packet.acceptance_criteria.length ? packet.acceptance_criteria : (task.goal?.success_criteria || (completed ? ["Agent task reached verified completion"] : [])),
          evidence: [...(Array.isArray(packet.evidence) ? packet.evidence : []).filter(item => item?.type !== "continuity_checkpoint"), ...resultEvidence, continuityEvidence].slice(-100),
          blockers,
          artifacts,
          risks: [...(Array.isArray(packet.risks) ? packet.risks : []), ...ambiguousOperations.map(item => `Ambiguous operation: ${item.capability || "unknown"}`)].slice(-50),
          relationships: [...(Array.isArray(packet.relationships) ? packet.relationships : []), { type: "agent_task", task_id: task.task_id, project: task.project_id || null }].slice(-50),
          // The immediate next step gets a receiver safely moving. The current
          // plan and operation ledger give that receiver the entire remaining
          // route, including work that follows the first safe action.
          plan: currentPlan?.plan || packet.plan || null,
          continuation: {
            completed_operations: completedOperations,
            ambiguous_operations: ambiguousOperations,
            current_milestone: task.current_milestone || null,
            active_work_package: task.active_work_package || null,
          },
          provenance: { ...(packet.provenance || {}), task_id: task.task_id, working_directory: packet.provenance?.working_directory || taskDirectory, workspace_ref: task.workspace_ref || null, plan_revision: Number(task.current_plan_revision) || 0, checkpoint_updated_at: task.checkpoint?.updated_at || null },
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
    if (typeof refreshHandoffEvidence === "function") {
      refreshHandoffEvidence(task.handoff_id, { working_directory: handoff.packet?.provenance?.working_directory || taskDirectory, actor: task.actor_id || "agent" });
    }
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
