"use strict";

function createWatchScheduler({
  loadWatches,
  saveWatches,
  claimScheduledDefinition,
  pauseWatchForCancel,
  startScheduledLeaseRenewal,
  releaseScheduledClaim,
  createScheduledPlatformExecution,
  appendScheduledPlatformEvent,
  transitionExecution,
  executeWatchAction,
  checkService,
  checkProcess,
  checkEndpoint,
  checkFile,
  evaluateWatchCondition,
  processId,
}) {
  const watchIntervals = {};

  function parseWatchInterval(interval) {
    if (!interval) return 60000;
    const match = interval.match(/^(\d+)(s|m|h)$/);
    if (!match) return 60000;
    return parseInt(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2]];
  }

  async function checkWatch(watch) {
    const watches = loadWatches();
    const current = watches.find(w => w.id === watch.id);
    if (!current || current.status !== "active") return;

    let checkClaim = { ok: true, claim: null };
    if (current.platform_execution_id) {
      checkClaim = claimScheduledDefinition(current, `sidekick-agent:${processId}`, "watch");
      if (!checkClaim.ok) {
        if (checkClaim.code !== "claim_held") console.log(`Watch ${watch.id} tick skipped (${checkClaim.code})`);
        return;
      }
      if (checkClaim.claim && checkClaim.claim.cancel_requested) {
        pauseWatchForCancel(current, checkClaim.claim, { source: "agent", actor: "agent" });
        if (watchIntervals[watch.id]) {
          clearInterval(watchIntervals[watch.id]);
          delete watchIntervals[watch.id];
        }
        console.log(`Watch ${watch.id} paused by cancel request`);
        return;
      }
    }

    const renewTimer = startScheduledLeaseRenewal(current.platform_execution_id, checkClaim.claim);
    try {
      const checkExecution = createScheduledPlatformExecution("watch", watch, {
        attach: false,
        parentExecutionId: watch.platform_execution_id || null,
        rootExecutionId: watch.platform_execution_id || null,
        operationType: "watch_check",
        state: "running",
        source: "agent",
        actor: "agent",
        risk: "medium",
        metadata: { source: watch.source, target: watch.target, network_scope: watch.network_scope || null, network_scope_revision: watch.network_scope_revision || null, condition: watch.condition },
        reason: "scheduled watch check started",
      });
      let checkResult;
      try {
        if (watch.source === "service") checkResult = checkService(watch.target);
        else if (watch.source === "process") checkResult = checkProcess(watch.target);
        else if (watch.source === "endpoint") checkResult = await checkEndpoint(watch.target, watch.network_scope, watch.network_scope_revision);
        else if (watch.source === "file") checkResult = checkFile(watch.target, watch.condition === "content_matches" ? watch.value : null);
      } catch (error) {
        const reason = error.policyDenied ? "scheduled watch check denied by current security policy" : "scheduled watch check failed";
        if (checkExecution) transitionExecution(checkExecution.execution_id, "failed", {
          source: "agent", actor_id: "agent", reason,
          result_status: "failure", error_category: error.code || "watch_check_failed",
          result_summary: reason, correlation_id: watch.id,
        });
        appendScheduledPlatformEvent("watch", watch, "schedule.watch.check_failed", {
          code: String(error.code || "watch_check_failed").slice(0, 80),
        }, {
          source: "agent", actor: "agent", severity: "error",
          executionId: checkExecution?.execution_id,
          rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id,
        });
        const watchesAfter = loadWatches();
        const updated = watchesAfter.find(w => w.id === watch.id);
        if (updated) {
          updated.lastCheck = new Date().toISOString();
          saveWatches(watchesAfter);
        }
        return;
      }

      const triggered = evaluateWatchCondition(watch, checkResult);
      const watchesAfter = loadWatches();
      const updated = watchesAfter.find(w => w.id === watch.id);
      if (updated) {
        updated.lastCheck = new Date().toISOString();
        if (triggered) {
          updated.lastTriggered = new Date().toISOString();
          updated.triggerCount = (updated.triggerCount || 0) + 1;
          saveWatches(watchesAfter);
          console.log(`Watch ${watch.id} triggered: ${watch.source} ${watch.target} (${watch.condition})`);
          appendScheduledPlatformEvent("watch", updated, "schedule.watch.triggered", { check_result: checkResult }, { source: "agent", actor: "agent", executionId: checkExecution?.execution_id, rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id });
          const actionResult = await executeWatchAction(watch, checkResult, {
            parentId: checkExecution?.execution_id || watch.platform_execution_id || null,
            rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id || null,
            correlationId: watch.id,
          });
          if (checkExecution) transitionExecution(checkExecution.execution_id, actionResult?.isError ? "failed" : "completed", {
            source: "agent", actor_id: "agent",
            reason: actionResult?.isError ? "scheduled watch action failed" : "scheduled watch action completed",
            result_status: actionResult?.isError ? "failure" : "success",
            result_summary: actionResult?.content?.[0]?.text || "watch triggered",
            correlation_id: watch.id,
          });
        } else {
          if (checkExecution) transitionExecution(checkExecution.execution_id, "completed", {
            source: "agent", actor_id: "agent",
            reason: "scheduled watch check completed without trigger",
            result_status: "not_triggered", result_summary: `Watch ${watch.id} did not trigger`, correlation_id: watch.id,
          });
          saveWatches(watchesAfter);
        }
      }
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      releaseScheduledClaim(current.platform_execution_id, checkClaim.claim);
    }
  }

  function scheduleWatch(watch) {
    const intervalMs = parseWatchInterval(watch.interval);
    if (watchIntervals[watch.id]) {
      clearInterval(watchIntervals[watch.id]);
      delete watchIntervals[watch.id];
    }
    watchIntervals[watch.id] = setInterval(() => {
      checkWatch(watch).catch(e => console.error(`Watch ${watch.id} check failed: ${e.message}`));
    }, intervalMs);
    console.log(`Scheduled watch ${watch.id} every ${watch.interval} (${intervalMs}ms)`);
  }

  function loadAndScheduleWatches() {
    const active = loadWatches().filter(w => w.status === "active");
    for (const watch of active) scheduleWatch(watch);
    console.log(`Loaded ${active.length} active watches`);
  }

  return { watchIntervals, parseWatchInterval, checkWatch, scheduleWatch, loadAndScheduleWatches };
}

module.exports = { createWatchScheduler };
