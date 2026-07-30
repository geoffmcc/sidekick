"use strict";

/**
 * Scheduled liveness sweeper for parked tasks
 * (docs/adr-approval-continuation.md §7.2, invariant I11).
 *
 * Expiry used to be LAZY and best-effort: `expireApprovals` ran only inside
 * `listApprovals`, `resolveApproval`, and `claimApprovalExecution`, so an
 * approval nobody looked at never expired. That is tolerable when an unexpired
 * approval merely sits in a queue. It is NOT tolerable once a task's liveness
 * depends on it — a parked task whose approval silently passed its expiry would
 * wait forever, because the only thing that could wake it is the expiry it
 * never processed.
 *
 * So expiry becomes part of the correctness argument, and this sweeper is a
 * required component rather than a tuning knob:
 *
 *   - THE INTERVAL IS A CORRECTNESS PARAMETER. It bounds how long a task can
 *     wait past its approval's expiry. It is not merely a performance dial.
 *   - IT MUST BE DEPLOYED AND MONITORED. The explicit failure mode to avoid
 *     repeating is `recoverStaleApprovals`, which shipped exported with ZERO
 *     production callers. `startSweeper()` is called from the agent service
 *     (src/agent.js) so this one has a caller by construction, and every run
 *     reports counts for monitoring.
 *   - IT IS NOT SUFFICIENT ALONE. The runner re-checks `expires_at` at claim
 *     time (§6 Stage 2), so an approval that expired between the sweep and the
 *     claim is still refused. The sweeper bounds latency; the claim check
 *     enforces the rule.
 *
 * Three passes, in order. Each is independent — one failing must not prevent
 * the others, because they recover different failure classes.
 */

const { redactSensitive } = require("../redact");
const store = require("./store");
const continuation = require("./continuation");
const vocab = require("./vocabulary");

function getSweepIntervalMs() {
  const configured = parseInt(process.env.SIDEKICK_APPROVAL_SWEEP_INTERVAL_MS || "60000", 10);
  if (!Number.isFinite(configured)) return 60000;
  // Floor at 5s so a misconfiguration cannot spin; ceiling at 15min so the
  // upper bound on task wake latency stays defensible.
  return Math.min(Math.max(configured, 5000), 900000);
}

/**
 * Pass 1 — expiry. Selects exactly the query `idx_approvals_status_expiry`
 * exists to serve. `retry_authorized` is included because T10 refreshes
 * `expires_at` when it grants a retry, and that fresh window is meaningless
 * unless something enforces it (I24: a live authorization stays revocable and
 * expiring for as long as it is live).
 */
function sweepExpired(now = store.nowIso()) {
  const expired = store.listExpiredApprovals(now);
  const results = { examined: expired.length, woken: 0, orphaned: 0, skipped: [] };

  for (const approval of expired) {
    if (!approval.task_id) continue; // standalone approvals keep the legacy path
    const outcome = continuation.wake({ approvalId: approval.approval_id, trigger: "expire", actor: "sweeper", now });
    if (outcome.ok) {
      results.woken++;
      continue;
    }
    // T5 cannot repair a checkpoint whose binding no longer names this
    // approval; that is precisely T7's job.
    if (["not_bound", "approval_not_found", "checkpoint_state_mismatch"].includes(outcome.code)) {
      const recovered = continuation.recoverOrphan({ taskId: approval.task_id, actor: "sweeper", now });
      if (recovered.ok) { results.orphaned++; continue; }
      results.skipped.push({ approvalId: approval.approval_id, code: recovered.code });
      continue;
    }
    results.skipped.push({ approvalId: approval.approval_id, code: outcome.code });
  }
  return results;
}

/**
 * Pass 2 — orphan detection (§7.3). A liveness check INDEPENDENT of approvals:
 * a checkpoint parked on an approval that is missing, unreadable, or terminal
 * with no recorded outcome would otherwise be swept forever and never wake.
 */
function sweepOrphans(now = store.nowIso()) {
  const parked = store.listParkedCheckpoints();
  const results = { examined: parked.length, recovered: 0, skipped: [] };

  for (const checkpoint of parked) {
    if (!checkpoint.current_approval_id) continue; // already woken; a resume claim will pick it up
    const approval = store.getApproval(checkpoint.current_approval_id);

    let orphaned = false;
    if (!approval) {
      orphaned = true;
    } else if (vocab.TERMINAL_APPROVAL_STATUSES.includes(approval.status)) {
      // A wake-up that committed the approval half and lost the rest.
      const recorded = checkpoint.current_step_id
        ? store.getStepResult(checkpoint.task_id, checkpoint.current_step_id, checkpoint.plan_version)
        : null;
      orphaned = !recorded;
    } else {
      // Live row: orphaned only if its payload cannot be authenticated.
      try {
        const args = store.decryptJson(approval.args_encrypted);
        if (store.argsDigest(args || {}) !== approval.args_digest) orphaned = true;
      } catch {
        orphaned = true;
      }
    }

    if (!orphaned) continue;
    const recovered = continuation.recoverOrphan({ taskId: checkpoint.task_id, actor: "sweeper", now });
    if (recovered.ok) results.recovered++;
    else results.skipped.push({ taskId: checkpoint.task_id, code: recovered.code });
  }
  return results;
}

/**
 * Pass 3 — deadlines. The checkpoint's own `deadline_at` is the outer bound: a
 * task parked past its deadline is failed with `timed_out`, whatever its
 * approval says. A reconciling task is failed with the approval left
 * `reconciliation_required` for audit — a deadline must never silently resolve
 * an ambiguity (I15).
 */
function sweepDeadlines(now = store.nowIso()) {
  const overdue = store.listOverdueCheckpoints(now);
  const results = { examined: overdue.length, failed: 0, skipped: [] };
  for (const checkpoint of overdue) {
    const outcome = continuation.failOverdue({ taskId: checkpoint.task_id, now });
    if (outcome.ok) results.failed++;
    else results.skipped.push({ taskId: checkpoint.task_id, code: outcome.code });
  }
  return results;
}

/**
 * One full sweep. Returns structured counts suitable for monitoring — the
 * sweeper "needs monitoring, not just implementing".
 */
function runSweep({ now = store.nowIso() } = {}) {
  store.ensureApprovalContinuationSchema();
  const started = Date.now();
  const summary = { at: now, expiry: null, orphans: null, deadlines: null, errors: [] };

  for (const [key, pass] of [["expiry", sweepExpired], ["orphans", sweepOrphans], ["deadlines", sweepDeadlines]]) {
    try {
      summary[key] = pass(now);
    } catch (error) {
      // A failing pass must not prevent the others: they recover different
      // failure classes, and suppressing all three because one threw is how a
      // liveness dependency dies silently.
      summary.errors.push({ pass: key, message: redactSensitive(String(error && error.message || error)).slice(0, 200) });
    }
  }
  summary.duration_ms = Date.now() - started;
  return summary;
}

let timer = null;

function startSweeper({ intervalMs = getSweepIntervalMs(), onSweep = null } = {}) {
  if (timer) return { started: false, reason: "already_running", intervalMs };
  timer = setInterval(() => {
    let summary;
    try {
      summary = runSweep();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "approval.sweep_failed",
        error: redactSensitive(String(error && error.message || error)).slice(0, 200),
      }));
      return;
    }
    const acted = (summary.expiry?.woken || 0) + (summary.expiry?.orphaned || 0)
      + (summary.orphans?.recovered || 0) + (summary.deadlines?.failed || 0);
    if (acted > 0 || summary.errors.length > 0) {
      console.error(JSON.stringify({ level: summary.errors.length ? "error" : "info", event: "approval.sweep", ...summary }));
    }
    if (onSweep) { try { onSweep(summary); } catch {} }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { started: true, intervalMs };
}

function stopSweeper() {
  if (!timer) return { stopped: false };
  clearInterval(timer);
  timer = null;
  return { stopped: true };
}

function isRunning() {
  return timer !== null;
}

module.exports = {
  getSweepIntervalMs,
  sweepExpired,
  sweepOrphans,
  sweepDeadlines,
  runSweep,
  startSweeper,
  stopSweeper,
  isRunning,
};
