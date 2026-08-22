"use strict";

const { TERMINAL } = require("./task-model");

// Restart recovery is deliberately conservative: it only changes durable
// tasks after the kernel has fenced an expired execution claim. It never
// recreates a provider request or dispatches a tool from historical output.
function recoverDurableAgentTasks({ platformKernel, taskStore, now, actor = "agent-recovery" } = {}) {
  if (!platformKernel || !taskStore) throw new Error("recovery dependencies are required");
  const recoveredClaims = platformKernel.recoverOrphanedExecutions({ source: "agent", actor_id: actor });
  const recovered = [];
  const failed = [];
  for (const executionId of recoveredClaims.orphaned || []) {
    const execution = platformKernel.getExecution(executionId);
    if (!execution || !execution.task_id) continue;
    const task = taskStore.getTask(execution.task_id);
    if (!task || TERMINAL.has(task.state)) continue;
    const checkpoint = platformKernel.getExecutionClaim(executionId)?.checkpoint || task.checkpoint;
    const resumable = checkpoint && checkpoint.version === 1 && checkpoint.safe_boundary && checkpoint.next_action;
    if (resumable) {
      taskStore.updateTask(task.task_id, { state: "interrupted", phase: "recovery", checkpoint, next_action: checkpoint.next_action, last_error_code: "process_restart" }, "task.recovered");
      recovered.push(task.task_id);
    } else {
      taskStore.updateTask(task.task_id, { state: "failed", phase: "recovery", next_action: null, last_error_code: "non_resumable_after_restart" }, "task.non_resumable");
      failed.push(task.task_id);
    }
  }
  return { scanned: recoveredClaims.scanned || 0, orphaned: recoveredClaims.orphaned || [], recovered, failed, checked_at: now ? now() : new Date().toISOString() };
}

module.exports = { recoverDurableAgentTasks };
