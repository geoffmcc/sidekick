"use strict";

const { TERMINAL } = require("./task-model");

// Restart recovery is deliberately conservative: it only changes durable
// tasks after the kernel has fenced an expired execution claim. It never
// recreates a provider request or dispatches a tool from historical output.
async function recoverDurableAgentTasks({ platformKernel, taskStore, receiptStore, workPackageStore = null, inspectReceipt, retryReceipt, rollbackReceipt, now, actor = "agent-recovery" } = {}) {
  if (!platformKernel || !taskStore) throw new Error("recovery dependencies are required");
  const recoveredClaims = platformKernel.recoverOrphanedExecutions({ source: "agent", actor_id: actor });
  const workPackages = workPackageStore && typeof workPackageStore.recoverExpiredWorkPackages === "function" ? workPackageStore.recoverExpiredWorkPackages(now ? now() : new Date().toISOString()) : { queued: [], parked: [], checked_at: now ? now() : new Date().toISOString() };
  const recovered = [];
  const failed = [];
  for (const executionId of recoveredClaims.orphaned || []) {
    const execution = platformKernel.getExecution(executionId);
    if (!execution || !execution.task_id) continue;
    const task = taskStore.getTask(execution.task_id);
    if (!task || TERMINAL.has(task.state)) continue;
    const receipts = receiptStore ? receiptStore.listReceipts(task.task_id) : [];
    // A finalized receipt is durable provider evidence even when the process
    // crashed before the task checkpoint could record the completion.  Fold it
    // into the continuation ledger first; never dispatch it again.  Only
    // dispatched receipts require fresh postcondition inspection.
    const finalized = receipts.filter(receipt => receipt.outcome_state === "finalized");
    let finalizedFailure = false;
    for (const receipt of finalized) {
      try {
        taskStore.recordCompletedOperation(task.task_id, { fingerprint: receipt.action_fingerprint, capability: receipt.capability, read_only: false, receipt_ref: receipt.provider_receipt_ref || null, summary: "operation receipt was finalized before the restart checkpoint" });
        if (receiptStore.transitionReceipt) receiptStore.transitionReceipt(receipt.receipt_id, "verified", { provider_receipt_ref: receipt.provider_receipt_ref || null });
      } catch {
        finalizedFailure = true;
      }
    }
    if (finalizedFailure) { failed.push(task.task_id); continue; }
    const inFlight = receipts.filter(receipt => receipt.outcome_state === "dispatched");
    if (inFlight && inFlight.length) {
      let parkedAmbiguous = false;
      for (const receipt of inFlight) {
        let observation = null;
        try { observation = inspectReceipt ? await inspectReceipt({ receipt, task }) : null; } catch { observation = null; }
        const decision = observation && receiptStore.evaluateRecovery ? receiptStore.evaluateRecovery({ receipt, postcondition: observation.postcondition, targetState: observation.targetState, authorityAllowsRetry: observation.authorityAllowsRetry === true, policyAllowsRetry: observation.policyAllowsRetry === true }) : { decision: "escalate" };
        if (decision.decision === "completed") {
          if (receipt.outcome_state === "dispatched") receiptStore.transitionReceipt(receipt.receipt_id, "finalized", { provider_receipt_ref: observation.evidence_ref || null });
          receiptStore.transitionReceipt(receipt.receipt_id, "verified", { provider_receipt_ref: observation.evidence_ref || null });
          taskStore.recordCompletedOperation(task.task_id, { fingerprint: receipt.action_fingerprint, capability: receipt.capability, read_only: false, receipt_ref: observation.evidence_ref || null, summary: "fresh governed recovery evidence satisfied the recorded postcondition" });
          continue;
        }
        if (decision.decision === "retry" && retryReceipt) {
          let retried = null;
          try { retried = await retryReceipt({ receipt, task, observation }); } catch { retried = null; }
          if (retried && retried.ok === true) {
            receiptStore.transitionReceipt(receipt.receipt_id, "finalized", { provider_receipt_ref: retried.provider_receipt_ref || null });
            receiptStore.transitionReceipt(receipt.receipt_id, "verified", { provider_receipt_ref: retried.provider_receipt_ref || null });
            taskStore.recordCompletedOperation(task.task_id, { fingerprint: receipt.action_fingerprint, capability: receipt.capability, read_only: false, receipt_ref: retried.provider_receipt_ref || null, summary: "safe retry completed after fresh evidence proved the prior effect absent" });
            continue;
          }
        }
        if (decision.decision === "rollback" && rollbackReceipt) {
          let rolledBack = null;
          try { rolledBack = await rollbackReceipt({ receipt, task, observation }); } catch { rolledBack = null; }
          if (rolledBack && rolledBack.ok === true) {
            // A dispatched receipt cannot jump directly to rolled_back. Mark
            // the effect ambiguous first, then record the separately governed
            // rollback outcome. This preserves the historical mutation and
            // prevents a later recovery pass from replaying it.
            receiptStore.transitionReceipt(receipt.receipt_id, "ambiguous");
            receiptStore.transitionReceipt(receipt.receipt_id, "rolled_back", { provider_receipt_ref: rolledBack.provider_receipt_ref || null });
            taskStore.recordAmbiguousOperation(task.task_id, { fingerprint: receipt.action_fingerprint, capability: receipt.capability, reason: "partial effect was rolled back and verified during restart recovery" });
            continue;
          }
        }
        receiptStore.transitionReceipt(receipt.receipt_id, "ambiguous");
        taskStore.recordAmbiguousOperation(task.task_id, { fingerprint: receipt.action_fingerprint, capability: receipt.capability, reason: decision.reason || "restart recovery could not prove the mutation outcome" });
        parkedAmbiguous = true;
      }
      if (parkedAmbiguous) failed.push(task.task_id); else recovered.push(task.task_id);
      continue;
    }
    const checkpoint = platformKernel.getExecutionClaim(executionId)?.checkpoint || task.checkpoint;
    const resumable = checkpoint && checkpoint.version === 1 && checkpoint.safe_boundary && checkpoint.next_action;
    if (resumable) {
      taskStore.updateTask(task.task_id, { state: "interrupted", phase: "recovery", checkpoint, next_action: checkpoint.next_action, last_error_code: "process_restart" }, "task.recovered");
      recovered.push(task.task_id);
    } else {
      taskStore.updateTask(task.task_id, { state: "failed", phase: "recovery", next_action: null, last_error_code: "non_resumable_after_restart" }, "task.non_resumable");
      failed.push(task.task_id);
    }
  }
  return { scanned: recoveredClaims.scanned || 0, orphaned: recoveredClaims.orphaned || [], recovered, failed, work_packages: workPackages, checked_at: now ? now() : new Date().toISOString() };
}

module.exports = { recoverDurableAgentTasks };
