function createContinuationJobStarter({ brain, callLLM, callAgentTool, redactSensitive, inferProjectFromText, finalizeResumedTask, stepTimeoutMs }) {
  return function startApprovalContinuationJobs() {
    if (!brain || !brain.isEnabled()) return { started: false, reason: "brain_disabled" };
    let sweeper;
    let scheduler;
    try {
      sweeper = require("../approvals/sweeper").startSweeper();
      scheduler = require("../brain/scheduler").startResumeScheduler({
        buildDeps: async (taskId, checkpoint) => {
          let project = null;
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
              timeoutMs: stepTimeoutMs,
            }),
            redact: redactSensitive,
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
