"use strict";

// Scheduled-execution primitives, moved verbatim from src/tools-legacy.js
// (B-6) so the scheduling/runbook families, the remaining legacy handlers,
// and src/agent.js can share them without a legacy import. Depends only on
// the platform kernel and the execution context — both cycle-free leaves.
// The local getCurrentSource mirrors the legacy helper via
// toolContext.getExecutionSource() (behavior-identical: setSource writes
// through to toolContext, and getExecutionSource never returns falsy).

const platformKernel = require("../platform/kernel");
const toolContext = require("./context");

function getCurrentSource() {
  return toolContext.getExecutionSource() || "unknown";
}

function createScheduledPlatformExecution(kind, item, options = {}) {
  try {
    const projectId = options.projectId || toolContext.getExecutionContext().project || process.env.SIDEKICK_PROJECT || null;
    if (!options.allowConcurrent) {
      const guard = platformKernel.platformGuard(null, null, {
        operation_type: options.operationType || `${kind}_operation`,
        tool_name: options.toolName || item.tool || item.action_tool || null,
        project_id: projectId,
        dedupe_key: item.id || null,
        allowConcurrent: false,
      });
      if (!guard.allowed && guard.reason === "concurrent_execution" && guard.execution) {
        if (options.attach !== false) item.platform_execution_id = guard.execution.execution_id;
        return guard.execution;
      }
    }
    const execution = platformKernel.createExecution({
      parent_execution_id: options.parentExecutionId || null,
      root_execution_id: options.rootExecutionId || options.parentExecutionId || undefined,
      actor_id: options.actor || getCurrentSource() || "unknown",
      requested_by_principal_id: options.requestedByPrincipalId || toolContext.getExecutionContext().authIdentity?.requested_by_principal_id || toolContext.getExecutionContext().authIdentity?.principal_id || null,
      actor_principal_id: options.actorPrincipalId || toolContext.getExecutionContext().authIdentity?.principal_id || null,
      acting_for_principal_id: options.actingForPrincipalId || toolContext.getExecutionContext().authIdentity?.acting_for_principal_id || null,
      executed_by_principal_id: options.executedByPrincipalId || null,
      client_id: options.client || getCurrentSource() || null,
      trigger_type: options.triggerType || kind,
      operation_type: options.operationType || `${kind}_operation`,
      tool_name: options.toolName || item.tool || item.action_tool || null,
      tool_action: options.toolAction || null,
      risk: options.risk || "medium",
      project_id: projectId,
      deadline_at: options.deadlineAt || item.when || null,
      source: options.source || kind,
      correlation_id: options.correlationId || item.id,
      metadata: {
        kind,
        id: item.id,
        name: item.name || null,
        status: item.status || null,
        ...options.metadata,
      },
    });
    if (options.attach !== false) item.platform_execution_id = execution.execution_id;
    if (options.state && options.state !== "created") {
      platformKernel.transitionExecution(execution.execution_id, options.state, {
        source: options.source || kind,
        actor_id: options.actor || getCurrentSource() || "unknown",
        reason: options.reason || `${kind} ${options.state}`,
        correlation_id: options.correlationId || item.id,
      });
    }
    return execution;
  } catch (e) {
    // A scheduled/runbook operation must never continue as an untracked
    // process-lifetime action. The old null fallback let callers execute work
    // after the durable ledger failed, making restart/recovery and audit claims
    // false. Surface the failure so the governed caller can stop before work.
    const error = new Error(`durable execution setup failed for ${kind}: ${e.message}`);
    error.cause = e;
    throw error;
  }
}

function transitionScheduledPlatformExecution(kind, item, state, details = {}) {
  try {
    if (!item.platform_execution_id) return;
    const guard = platformKernel.platformGuard(item.platform_execution_id, null, { allowTerminal: false });
    if (!guard.allowed) return;
    platformKernel.transitionExecution(item.platform_execution_id, state, {
      source: details.source || kind,
      actor_id: details.actor || getCurrentSource() || "unknown",
      reason: details.reason,
      result_status: details.result_status,
      error_category: details.error_category,
      result_summary: details.result_summary,
      correlation_id: details.correlationId || item.id,
    });
  } catch (e) {}
}

function releaseScheduledClaim(executionId, claim) {
  if (!executionId || !claim) return { ok: true };
  try {
    return platformKernel.releaseExecutionClaim({ execution_id: executionId, claimed_by: claim.claimed_by, claim_epoch: claim.claim_epoch });
  } catch (e) {
    return { ok: false, code: "release_error" };
  }
}

// Renew the claim lease on an interval while a scheduled dispatch is in
// flight, so a slow tool call cannot be orphaned out from under a live
// runner. A failed renewal means the claim was superseded; the timer stops
// and the completion write is fenced by releaseScheduledClaim.
function startScheduledLeaseRenewal(executionId, claim) {
  if (!executionId || !claim) return null;
  const timer = setInterval(() => {
    try {
      const renewed = platformKernel.renewExecutionLease({ execution_id: executionId, claimed_by: claim.claimed_by, claim_epoch: claim.claim_epoch });
      if (!renewed.ok) clearInterval(timer);
    } catch (e) {}
  }, 60000);
  if (timer.unref) timer.unref();
  return timer;
}

function appendScheduledPlatformEvent(kind, item, eventType, payload = {}, options = {}) {
  try {
    platformKernel.appendEvent({
      event_type: eventType,
      source: options.source || kind,
      actor_id: options.actor || getCurrentSource() || "unknown",
      subject_type: kind,
      subject_id: item.id,
      execution_id: options.executionId || item.platform_execution_id || null,
      root_execution_id: options.rootExecutionId || item.platform_execution_id || null,
      severity: options.severity || "info",
      payload: {
        kind,
        id: item.id,
        name: item.name || null,
        status: item.status || null,
        ...payload,
      },
      correlation_id: options.correlationId || item.id,
    });
  } catch (e) {}
}


// Phase 4/B: scheduled work is serialized per item by claiming the item's
// long-lived definition execution for the duration of a dispatch (watch
// check, cron run) — two runners cannot both dispatch the same item. A crash
// mid-dispatch leaves an expired lease that the recovery scan flips to
// `orphaned`; the next dispatch re-queues it before claiming.
function claimScheduledDefinition(item, claimedBy, source) {
  if (!item.platform_execution_id) return { ok: true, claim: null };
  try {
    const exec = platformKernel.getExecution(item.platform_execution_id);
    if (exec && exec.state === "orphaned") {
      platformKernel.transitionExecution(item.platform_execution_id, "queued", { source, reason: `${source} definition re-queued after orphan recovery`, correlation_id: item.id });
    }
  } catch (e) {}
  return platformKernel.claimExecution({ execution_id: item.platform_execution_id, claimed_by: claimedBy });
}

module.exports = { createScheduledPlatformExecution, transitionScheduledPlatformExecution, releaseScheduledClaim, startScheduledLeaseRenewal, appendScheduledPlatformEvent, claimScheduledDefinition };
