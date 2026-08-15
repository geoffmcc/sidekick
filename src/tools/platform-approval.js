"use strict";

// Platform execution/event bookkeeping for the compatibility approval path.
// Keeping this separate lets tools-legacy retain its public approval facade
// without also owning platform-ledger integration details.
const platformKernel = require("../platform/kernel");

function recordPlatformApprovalQueued(item) {
  try {
    const execution = platformKernel.createExecution({
      actor_id: item.source || "unknown",
      client_id: item.source || null,
      trigger_type: "approval",
      operation_type: "approval_request",
      tool_name: item.tool,
      risk: item.risk || "unknown",
      approval_state: "pending",
      deadline_at: item.expires_at || null,
      source: "approvals",
      correlation_id: item.id,
      metadata: { approval_id: item.id, approval_mode: item.mode, approval_reason: item.reason },
    });
    item.platform_execution_id = execution.execution_id;
    platformKernel.transitionExecution(execution.execution_id, "awaiting_approval", {
      source: "approvals", actor_id: item.source || "unknown", reason: "approval requested", correlation_id: item.id,
    });
    platformKernel.appendEvent({
      event_type: "approval.requested", source: "approvals", actor_id: item.source || "unknown",
      subject_type: "approval", subject_id: item.id, execution_id: execution.execution_id,
      root_execution_id: execution.root_execution_id,
      payload: { approval_id: item.id, tool: item.tool, risk: item.risk, source: item.source, mode: item.mode, reason: item.reason, expires_at: item.expires_at },
      correlation_id: item.id,
    });
  } catch (e) {}
}

function transitionPlatformApproval(item, state, details = {}) {
  try {
    if (!item.platform_execution_id) return;
    const guard = platformKernel.platformGuard(item.platform_execution_id, null, { allowTerminal: state === "failed" || state === "timed_out" });
    if (!guard.allowed && guard.reason === "terminal_state") return;
    platformKernel.transitionExecution(item.platform_execution_id, state, {
      source: "approvals", actor_id: details.actor_id || item.reviewed_by || item.source || "unknown",
      reason: details.reason, result_status: details.result_status, error_category: details.error_category,
      result_summary: details.result_summary, correlation_id: item.id,
    });
  } catch (e) {}
}

function recordPlatformApprovalEvent(item, eventType, payload = {}, options = {}) {
  try {
    platformKernel.appendEvent({
      event_type: eventType, source: "approvals", actor_id: options.actor_id || item.reviewed_by || item.source || "unknown",
      subject_type: "approval", subject_id: item.id, execution_id: item.platform_execution_id || null,
      root_execution_id: item.platform_execution_id || null, severity: options.severity || "info",
      payload: { approval_id: item.id, tool: item.tool, status: item.status, ...payload }, correlation_id: item.id,
    });
  } catch (e) {}
}

function recordPlatformChangeSet(item, decision, details = {}) {
  try {
    return platformKernel.createChangeSet({
      execution_id: item.platform_execution_id || null, approval_id: item.id, tool_name: item.tool,
      tool_action: details.tool_action || null, operation_type: "approval", state: decision,
      actor_id: details.actor_id || item.reviewed_by || item.source || "unknown", decision,
      reason: details.reason || null, args: details.args || item.args || {},
      result_summary: details.result_summary || null, project_id: details.project || null, source: "approvals",
    });
  } catch (e) { return null; }
}

module.exports = {
  recordPlatformApprovalQueued,
  transitionPlatformApproval,
  recordPlatformApprovalEvent,
  recordPlatformChangeSet,
};
