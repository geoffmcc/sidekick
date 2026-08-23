function createContinuationJobStarter({ brain, callLLM, callAgentTool, redactSensitive, inferProjectFromText, finalizeResumedTask, stepTimeoutMs, getLiveAgentToolDefs = () => [], getTask = () => null }) {
  return function startApprovalContinuationJobs() {
    if (!brain || !brain.isEnabled()) return { started: false, reason: "brain_disabled" };
    let sweeper;
    let scheduler;
    try {
      sweeper = require("../approvals/sweeper").startSweeper();
      scheduler = require("../brain/scheduler").startResumeScheduler({
        buildDeps: async (taskId, checkpoint) => {
          let project = null;
          const durableTask = getTask(taskId) || null;
          const authIdentity = durableTask && (durableTask.actor_principal_id || durableTask.requested_by_principal_id)
            ? { principal_id: durableTask.actor_principal_id || durableTask.requested_by_principal_id, scopes: durableTask.principal_context?.credential_scopes || [], delegation_id: durableTask.principal_context?.delegation_id || null }
            : null;
          try {
            const store = require("../approvals/store");
            const goal = checkpoint ? store.decryptJson(checkpoint.goal_encrypted) : null;
            if (typeof goal === "string" && goal) project = inferProjectFromText(goal) || null;
          } catch {}
          return brain.makeResumeDeps({
            callLLM: (messages, options) => callLLM(messages, options),
            callTool: (name, args) => callAgentTool(name, args, {
              taskId,
              source: "agent",
              correlationId: taskId,
              project,
              authIdentity,
              timeoutMs: stepTimeoutMs,
            }),
            redact: redactSensitive,
            toolContracts: getLiveAgentToolDefs(),
            agentTools: getLiveAgentToolDefs(),
            concurrencyLimit: Math.max(1, Math.min(16, Number(getTask(taskId)?.authority_envelope?.concurrency_limit) || 1)),
            workPackageHooks: {
              start: async (step) => {
                const operations = require("./durable-operations");
                const taskStore = require("./task-store");
                taskStore.incrementUsage(taskId, { work_packages: 1 }, "task.resume_brain_work_package_reserved");
                const packageRecord = operations.createWorkPackage({ task_id: taskId, package_key: `brain-resume:${String(step.id || step.tool || "step").slice(0, 72)}` });
                return operations.claimWorkPackage(packageRecord.package_id, `agent:${taskId}`);
              },
              finish: async (packageRecord, state, result) => require("./durable-operations").finishWorkPackage(packageRecord.package_id, state, result, `agent:${taskId}`),
            },
          });
        },
        onPass: (outcomes) => {
          for (const entry of outcomes) {
            try {
              const delivered = finalizeResumedTask(entry);
              if (delivered && delivered.ok === false) {
                console.error(JSON.stringify({
                  level: "error",
                  event: "brain.resume_delivery_incomplete",
                  task_id: entry.taskId,
                  reason: delivered.reason || "unknown",
                }));
              }
            } catch (error) {
              console.error(JSON.stringify({
                level: "error",
                event: "brain.resume_delivery_failed",
                task_id: entry.taskId,
                error: redactSensitive(String(error && error.message || error)).slice(0, 200),
              }));
            }
          }
        },
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "approval.continuation_jobs_failed",
        error: redactSensitive(String(error && error.message || error)).slice(0, 200),
      }));
      return { started: false, reason: "error" };
    }
    console.log(`Approval continuation: sweeper ${sweeper.started ? "every " + sweeper.intervalMs + "ms" : "not started"}, resume scheduler ${scheduler.started ? "every " + scheduler.intervalMs + "ms" : "not started"}`);
    return { started: true, sweeper, scheduler };
  };
}

module.exports = { createContinuationJobStarter };
