"use strict";

const { createAgentExecutionContext } = require("../tools/context");

/**
 * Build the AsyncLocalStorage context for one Agent task. An explicit empty
 * parent is important: a new task without an authenticated principal must not
 * inherit authority from an unrelated ambient async operation.
 */
function createTaskExecutionContext(parentContext, taskId) {
  return createAgentExecutionContext({
    parentContext: parentContext || {},
    authIdentity: parentContext?.authIdentity || null,
    actor: parentContext?.actorPrincipalId || parentContext?.requestedByPrincipalId || "agent",
    taskId,
    project: parentContext?.project || null,
    sessionId: parentContext?.sessionId || null,
    correlationId: taskId,
  });
}

module.exports = { createTaskExecutionContext };
