"use strict";

function createDelayExecution({
  loadDelays,
  saveDelays,
  callAgentTool,
  claimExecution,
  releaseScheduledClaim,
  startScheduledLeaseRenewal,
  transitionScheduledPlatformExecution,
  appendScheduledPlatformEvent,
  getDelayTimers,
  processId,
}) {
  return async function executeDelay(delay) {
    const delays = loadDelays();
    const current = delays.find(d => d.id === delay.id);
    const timers = getDelayTimers();
    if (!current || current.status !== "pending") {
      delete timers[delay.id];
      return;
    }

    let runClaim = null;
    if (current.platform_execution_id) {
      const claimRes = claimExecution({ execution_id: current.platform_execution_id, claimed_by: `sidekick-agent:${processId}` });
      if (!claimRes.ok) {
        console.log(`Delay ${delay.id} not dispatchable (${claimRes.code}${claimRes.claimed_by ? `, held by ${claimRes.claimed_by}` : ""}), skipping`);
        delete timers[delay.id];
        return;
      }
      runClaim = claimRes.claim;
      if (runClaim.cancel_requested) {
        current.status = "cancelled";
        current.cancelledAt = new Date().toISOString();
        transitionScheduledPlatformExecution("delay", current, "cancelled", { source: "agent", actor: "agent", reason: "cancel requested before dispatch", result_status: "cancelled" });
        appendScheduledPlatformEvent("delay", current, "schedule.delay.cancelled", { cancelled_at: current.cancelledAt }, { source: "agent", actor: "agent" });
        saveDelays(delays);
        releaseScheduledClaim(current.platform_execution_id, runClaim);
        delete timers[delay.id];
        console.log(`Delay ${delay.id} cancelled before dispatch`);
        return;
      }
    }

    current.status = "running";
    current.startedAt = new Date().toISOString();
    transitionScheduledPlatformExecution("delay", current, "running", { source: "agent", actor: "agent", reason: "scheduled delay execution started" });
    saveDelays(delays);
    const renewTimer = startScheduledLeaseRenewal(current.platform_execution_id, runClaim);
    console.log(`Executing delay ${delay.id}: ${delay.tool}`);
    try {
      const result = await callAgentTool(delay.tool, delay.args || {}, {
        parentId: current.platform_execution_id || null,
        rootExecutionId: current.platform_execution_id || null,
        correlationId: delay.id,
      });
      if (renewTimer) clearInterval(renewTimer);
      const release = releaseScheduledClaim(current.platform_execution_id, runClaim);
      if (runClaim && !release.ok && release.code === "release_rejected") {
        console.error(`Delay ${delay.id} completed but its claim was superseded; leaving state to the current claimant`);
        delete timers[delay.id];
        return;
      }
      const delaysAfter = loadDelays();
      const updated = delaysAfter.find(d => d.id === delay.id);
      if (updated) {
        updated.status = result.isError ? "failed" : "completed";
        updated.completedAt = new Date().toISOString();
        updated.result = result.content?.[0]?.text?.substring(0, 200) || "ok";
        transitionScheduledPlatformExecution("delay", updated, result.isError ? "failed" : "completed", { source: "agent", actor: "agent", reason: result.isError ? "scheduled delay execution failed" : "scheduled delay execution completed", result_status: result.isError ? "failure" : "success", result_summary: updated.result });
        appendScheduledPlatformEvent("delay", updated, result.isError ? "schedule.delay.failed" : "schedule.delay.completed", { completed_at: updated.completedAt }, { source: "agent", actor: "agent", severity: result.isError ? "error" : "info" });
        saveDelays(delaysAfter);
      }
      console.log(`Delay ${delay.id} completed`);
    } catch (error) {
      if (renewTimer) clearInterval(renewTimer);
      const release = releaseScheduledClaim(current.platform_execution_id, runClaim);
      if (runClaim && !release.ok && release.code === "release_rejected") {
        console.error(`Delay ${delay.id} threw (${error.message}) but its claim was superseded; leaving state to the current claimant`);
        delete timers[delay.id];
        return;
      }
      const delaysAfter = loadDelays();
      const updated = delaysAfter.find(d => d.id === delay.id);
      if (updated) {
        updated.status = "failed";
        updated.completedAt = new Date().toISOString();
        updated.error = error.message;
        transitionScheduledPlatformExecution("delay", updated, "failed", { source: "agent", actor: "agent", reason: "scheduled delay execution threw", result_status: "failure", result_summary: error.message });
        appendScheduledPlatformEvent("delay", updated, "schedule.delay.failed", { error: error.message }, { source: "agent", actor: "agent", severity: "error" });
        saveDelays(delaysAfter);
      }
      console.error(`Delay ${delay.id} failed: ${error.message}`);
    }
    delete timers[delay.id];
  };
}

module.exports = { createDelayExecution };
