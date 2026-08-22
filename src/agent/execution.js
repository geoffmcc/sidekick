const fs = require("fs");
const path = require("path");
const platformKernel = require("../platform/kernel");
const { redactSensitive } = require("../redact");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");

function startAgentExecution(goal, taskId, project, lineage = null) {
  try {
    const execution = platformKernel.createExecution({
      task_id: taskId,
      parent_execution_id: (lineage && lineage.parentExecutionId) || null,
      root_execution_id: (lineage && lineage.rootExecutionId) || null,
      session_id: (lineage && lineage.sessionId) || null,
      project_id: project || null,
      actor_id: "agent", client_id: "agent-bridge", trigger_type: "agent",
      operation_type: "agent_task", tool_name: "sidekick_agent", tool_action: "run",
      resource_scope: project || "agent", environment: process.env.SIDEKICK_ENVIRONMENT || null,
      requested_by_principal_id: lineage?.requestedByPrincipalId || null,
      actor_principal_id: lineage?.actorPrincipalId || null,
      acting_for_principal_id: lineage?.actingForPrincipalId || null,
      executed_by_principal_id: lineage?.actorPrincipalId || null,
      risk: "medium", source: "agent", correlation_id: taskId,
      metadata: {
        goal_summary: redactSensitive(String(goal || "")).slice(0, 300),
        ...(lineage && lineage.parentTaskId ? { parent_task_id: lineage.parentTaskId, root_task_id: lineage.rootTaskId, continuation_depth: lineage.continuationDepth } : {}),
      },
    });
    const running = platformKernel.transitionExecution(execution.execution_id, "running", { source: "agent", reason: "agent task started" });
    // Active Agent work owns a platform claim so bounded checkpoints and
    // cancellation are fenced. Approval parking releases this claim; the
    // existing approval continuation reclaims through its own binding.
    let claim = null;
    try { claim = platformKernel.claimExecution({ execution_id: running.execution_id, claimed_by: `sidekick-agent:${process.pid}:${taskId}`, lease_ms: 300000 }); } catch { /* Older deployments may not have claims yet; execution remains governed. */ }
    return { ...running, agent_claim: claim && claim.ok ? claim.claim : null };
  } catch { return null; }
}

function checkpointAgentExecution(execution, workState) {
  if (!execution?.agent_claim || !workState) return { ok: false, code: "not_claimed" };
  try {
    return platformKernel.checkpointExecution({
      execution_id: execution.execution_id,
      claimed_by: execution.agent_claim.claimed_by,
      claim_epoch: execution.agent_claim.claim_epoch,
      checkpoint: { version: 1, kind: "agent_work_state", state: workState },
    });
  } catch { return { ok: false, code: "checkpoint_error" }; }
}

function appendAgentExecutionEvent(execution, eventType, payload = {}, severity = "info") {
  if (!execution) return;
  try {
    platformKernel.appendEvent({
      event_type: eventType, source: "agent", actor_id: execution.actor_id,
      execution_id: execution.execution_id, root_execution_id: execution.root_execution_id,
      task_id: execution.task_id, session_id: execution.session_id,
      project_id: execution.project_id, environment: execution.environment,
      severity, payload, correlation_id: execution.root_execution_id,
    });
  } catch { /* Platform observability must not interrupt task execution. */ }
}

function finishAgentExecution(execution, status, details = {}) {
  if (!execution) return;
  const state = status === "completed" ? "completed"
    : status === "iteration_limit" ? "timed_out"
      : status === "waiting_for_approval" ? "awaiting_approval"
        : status === "cancelled" ? "cancelled" : "failed";
  try {
    platformKernel.transitionExecution(execution.execution_id, state, {
      source: "agent", actor_id: execution.actor_id, result_status: status,
      error_category: details.error_category || null,
      result_summary: details.result_summary || null, reason: details.reason || null,
    });
  } catch { /* Platform observability must not interrupt task execution. */ }
  try {
    if (execution.agent_claim) platformKernel.releaseExecutionClaim({ execution_id: execution.execution_id, claimed_by: execution.agent_claim.claimed_by, claim_epoch: execution.agent_claim.claim_epoch });
  } catch { /* Terminal transition remains authoritative if claim cleanup fails. */ }
}

function registerAgentTranscript(execution, transcriptPath, taskId, status) {
  if (!execution || !transcriptPath) return;
  try {
    const stat = fs.statSync(transcriptPath);
    platformKernel.registerArtifact({
      execution_id: execution.execution_id, task_id: execution.task_id,
      project_id: execution.project_id, producer: "agent", type: "agent_transcript",
      name: `${taskId}.json`, storage_ref: path.relative(DATA_DIR, transcriptPath),
      content_type: "application/json", byte_size: stat.size, sensitivity: "sensitive",
      redaction_state: "unknown", source: "agent", correlation_id: execution.root_execution_id,
      metadata: { status },
      ownerPrincipalId: execution.actor_principal_id || execution.requested_by_principal_id || null,
      createdByPrincipalId: execution.actor_principal_id || execution.requested_by_principal_id || null,
    });
  } catch { /* Existing conversation storage remains authoritative. */ }
}

module.exports = { startAgentExecution, checkpointAgentExecution, appendAgentExecutionEvent, finishAgentExecution, registerAgentTranscript };
