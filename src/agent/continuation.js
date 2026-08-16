const {
  CONTINUATION_LIMITS, ContinuationError, isTerminalStatus,
  loadTranscript, normalizeTranscript, resolveAncestors, buildContinuationContext,
} = require("../agent-continuation");

function buildChildLineage(parentTaskId, conversationDir) {
  const parent = normalizeTranscript(loadTranscript(conversationDir, parentTaskId), parentTaskId);
  if (!isTerminalStatus(parent.status)) {
    throw new ContinuationError("parent_not_terminal", "Parent task is not in a terminal state", 409);
  }
  const childDepth = (parent.continuation_depth || 0) + 1;
  if (childDepth > CONTINUATION_LIMITS.MAX_CONTINUATION_DEPTH) {
    throw new ContinuationError("depth_exceeded", "Continuation depth limit reached for this thread", 422);
  }
  const ancestors = resolveAncestors(parent, id => normalizeTranscript(loadTranscript(conversationDir, id), id));
  const { text } = buildContinuationContext({ ancestors });
  return {
    parentTaskId,
    rootTaskId: parent.root_task_id || parentTaskId,
    continuationDepth: childDepth,
    continuationBrief: text,
    sessionId: parent.session_id || null,
    project: parent.project || null,
    parentExecutionId: parent.lineage.platform_execution_id || null,
    rootExecutionId: parent.lineage.root_execution_id || null,
    requestedByPrincipalId: parent.requested_by_principal_id || null,
    actorPrincipalId: parent.actor_principal_id || null,
    actingForPrincipalId: parent.acting_for_principal_id || null,
  };
}

module.exports = { buildChildLineage };
