"use strict";

/**
 * Task runner loop for resumable Brain tasks
 * (docs/adr-approval-continuation.md §1, I17).
 *
 * A task made runnable by ANY path must be claimable and must actually be
 * claimed by something — otherwise T2 produces an approved approval attached to
 * a task that sits `runnable` forever, which is the same stranding the ADR
 * exists to remove, one step later.
 *
 * This is that something. It polls for claimable checkpoints — `runnable`, or
 * `running` with an expired lease — and resumes each through
 * `resumeBrainTask`. Claiming is transactional (T3), so a poll that races
 * another runner simply loses and moves on; correctness rests on
 * `BEGIN IMMEDIATE` and the state predicate, not on there being one poller.
 *
 * Deliberately a poller rather than a callback from the approval path: driving
 * resumption from the approval side would mean the approval pipeline decides
 * when a task runs, reintroducing exactly the coupling I3 removes (ADR
 * alternative F).
 */

const { redactSensitive } = require("../redact");
const store = require("../approvals/store");
const { resumeBrainTask } = require("./resume");

function getPollIntervalMs() {
  const configured = parseInt(process.env.SIDEKICK_BRAIN_RESUME_INTERVAL_MS || "5000", 10);
  if (!Number.isFinite(configured)) return 5000;
  return Math.min(Math.max(configured, 1000), 300000);
}

function runnerIdentity() {
  return `runner_${process.pid || "pid"}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One pass. Returns per-task outcomes so a caller (or a test) can assert on
 * what happened rather than inferring it from side effects.
 *
 * `buildDeps(taskId)` supplies the execution seams for one task — the same
 * dispatcher, synthesis and redaction wiring the live path uses. It is a
 * factory rather than a fixed object because the seams are task-scoped
 * (execution ids, correlation, cancellation).
 */
async function resumeClaimable({ buildDeps, claimedBy = runnerIdentity(), limit = 5 } = {}) {
  store.ensureApprovalContinuationSchema();
  const claimable = store.listClaimableCheckpoints().slice(0, limit);
  const outcomes = [];

  for (const checkpoint of claimable) {
    let deps;
    try {
      deps = await buildDeps(checkpoint.task_id, checkpoint);
    } catch {
      outcomes.push({ taskId: checkpoint.task_id, state: "not_resumed", code: "deps_unavailable" });
      continue;
    }
    if (!deps) {
      outcomes.push({ taskId: checkpoint.task_id, state: "not_resumed", code: "no_deps" });
      continue;
    }
    try {
      const outcome = await resumeBrainTask({ taskId: checkpoint.task_id, claimedBy, ...deps });
      // The FULL outcome is carried out, not just its state. A resumed task
      // synthesizes a real answer for the human who approved the action; a
      // caller that only learns the state has no way to deliver it, and the
      // answer is discarded — which would leave the requester with nothing to
      // show for having approved anything.
      outcomes.push({
        taskId: checkpoint.task_id,
        state: outcome.state,
        code: outcome.code || null,
        outcome,
        checkpoint,
      });
    } catch (error) {
      // A single task's failure must not stop the loop: the next poll would hit
      // the same task first and the queue behind it would never drain.
      console.error(JSON.stringify({
        level: "error",
        event: "brain.resume_failed",
        task_id: checkpoint.task_id,
        error: redactSensitive(String(error && error.message || error)).slice(0, 200),
      }));
      outcomes.push({ taskId: checkpoint.task_id, state: "error" });
    }
  }
  return outcomes;
}

let timer = null;
let inFlight = false;

function startResumeScheduler({ buildDeps, intervalMs = getPollIntervalMs(), onPass = null } = {}) {
  if (timer) return { started: false, reason: "already_running" };
  if (typeof buildDeps !== "function") return { started: false, reason: "buildDeps_required" };

  timer = setInterval(async () => {
    // Non-reentrant: a slow pass must not stack passes that then race each
    // other for the same checkpoints.
    if (inFlight) return;
    inFlight = true;
    try {
      const outcomes = await resumeClaimable({ buildDeps });
      if (outcomes.length && onPass) { try { onPass(outcomes); } catch {} }
      const resumed = outcomes.filter(o => o.state && !["not_claimed", "not_resumed"].includes(o.state));
      if (resumed.length) {
        // Log identity and state ONLY. The entries now carry the full outcome
        // so `onPass` can deliver the answer, and that answer is synthesized
        // from tool output — logging it here would put task content in stderr,
        // which is precisely the accidental-exfiltration path PR #141 fixed.
        console.error(JSON.stringify({
          level: "info",
          event: "brain.resume_pass",
          resumed: resumed.length,
          outcomes: resumed.map(o => ({ taskId: o.taskId, state: o.state, code: o.code })),
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "brain.resume_pass_failed",
        error: redactSensitive(String(error && error.message || error)).slice(0, 200),
      }));
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { started: true, intervalMs };
}

function stopResumeScheduler() {
  if (!timer) return { stopped: false };
  clearInterval(timer);
  timer = null;
  inFlight = false;
  return { stopped: true };
}

function isRunning() {
  return timer !== null;
}

module.exports = {
  getPollIntervalMs,
  runnerIdentity,
  resumeClaimable,
  startResumeScheduler,
  stopResumeScheduler,
  isRunning,
};
