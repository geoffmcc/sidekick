const crypto = require("crypto");
const EventEmitter = require("events");

/**
 * Creates the shared HTTP-to-runner path used by root tasks and follow-ups.
 * The mutable maps and runner callback stay owned by agent.js and are injected
 * so this module remains a small orchestration boundary.
 */
function createTaskRunner({ taskEmitters, taskCancels, emit, runAgent, redactSensitive }) {
  return function beginTaskRun(res, { goal, parentContext = null }) {
    const taskId = crypto.randomUUID().slice(0, 8);
    taskEmitters[taskId] = new EventEmitter();
    taskCancels[taskId] = new AbortController();
    const payload = { taskId };
    if (parentContext) {
      payload.parentTaskId = parentContext.parentTaskId;
      payload.rootTaskId = parentContext.rootTaskId;
      payload.continuationDepth = parentContext.continuationDepth;
    }
    res.json(payload);
    runAgent(goal, taskId, parentContext, taskCancels[taskId])
      .catch((e) => {
        try {
          emit(taskId, { type: "error", text: redactSensitive("Task failed to run: " + (e && e.message ? e.message : "unknown error")) });
        } catch {}
        console.error("Agent task " + taskId + " failed: " + (e && e.message ? e.message : e));
      })
      .finally(() => {
        delete taskCancels[taskId];
        setTimeout(() => delete taskEmitters[taskId], 60000);
      });
    return taskId;
  };
}

module.exports = { createTaskRunner };
