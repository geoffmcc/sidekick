"use strict";

// Runs async provider-backed jobs through the durable compute job ledger.
// Worker-backed jobs remain owned by the enrolled worker scheduler; this
// runner is only for jobs explicitly marked async and backed by a provider.

const inferenceService = require("./inference-service");
const jobManager = require("./job-manager");
const workerManager = require("./worker-manager");
const { redactSensitive } = require("../redact");

const POLL_INTERVAL_MS = 250;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.SIDEKICK_DIRECT_JOB_CONCURRENCY || 1));
const MAX_CONTINUATIONS = 3;
// Short lease, renewed while the generation actually runs. The old lease was
// max(timeoutMs + 60s, 15m) — with the async tool's default 24h timeout, a
// process crash mid-run stranded the job for a DAY before recovery could act.
// A 5-minute lease bounds that window to minutes; execute() renews it on a
// heartbeat far inside the lease so a live run never lapses.
const DIRECT_LEASE_MS = 300000;
const LEASE_RENEW_INTERVAL_MS = 60000;
let timer = null;
let inFlight = 0;

function isDirectInferenceJob(job) {
  return (job.jobType === "chat" || job.jobType === "generate") &&
    job.requestPayload && job.requestPayload.async === true;
}

// Worker-backed Ollama is authoritative when an enrolled worker advertises
// the real executor. Direct-provider execution remains the safe fallback for
// installations that have not enabled Ollama on a worker yet.
function hasEligibleWorker(job) {
  return workerManager.listWorkers().some(worker =>
    (worker.state === "online" || worker.state === "degraded") &&
    jobManager.workerCanRunJob(worker, job)
  );
}

// Direct jobs have no worker identity; getCancellationStatus accepts the null
// workerId because the job row's selected_worker_id is also null, while still
// enforcing lease ownership. A thrown LeaseExpiredError means the ledger has
// already taken the attempt away (cancel finalized or lease recovered) — in
// either case the only correct move is to stop and publish nothing.
function cancellationRequested(jobId, leaseId) {
  try {
    return jobManager.getCancellationStatus(jobId, null, leaseId).cancelled === true;
  } catch {
    return true;
  }
}

// Best-effort two-phase finalization: acks a 'cancelling' job so it reaches
// terminal 'cancelled' promptly instead of waiting for lease-expiry recovery.
// Every failure mode here means the ledger already resolved the attempt, so
// the errors that used to surface as failDirectJob LeaseExpiredError noise
// are deliberately swallowed.
function finalizeCancellation(jobId, leaseId) {
  try { jobManager.acknowledgeCancellation(jobId, null, leaseId); } catch { /* already terminal or superseded */ }
}

async function execute(claimed) {
  const { job, leaseId } = claimed;
  const payload = { ...(job.requestPayload || {}) };
  delete payload.async;

  // Renew the short lease while the generation runs; stop renewing the moment
  // the lease is no longer ours (cancelled or recovered) and let the
  // cancellation/completion checks below observe that through the ledger.
  const renewTimer = setInterval(() => {
    try { jobManager.renewLease(job.jobId, leaseId, DIRECT_LEASE_MS); }
    catch { clearInterval(renewTimer); }
  }, LEASE_RENEW_INTERVAL_MS);
  if (renewTimer.unref) renewTimer.unref();

  try {
    let result;
    if (job.jobType === "chat") {
      result = await runChatToCompletion(job, payload, leaseId);
    } else {
      result = await inferenceService.generate(payload.prompt, {
        system: payload.system,
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        contextLimit: payload.contextLimit,
        timeout: job.timeoutMs,
        dataClassification: job.dataClassification,
        preferences: { allowFallback: true },
      });
    }
    // A cancel that arrived during generation discards the result cleanly:
    // ack (finalizing 'cancelling' → 'cancelled'), never publish.
    if (cancellationRequested(job.jobId, leaseId)) {
      finalizeCancellation(job.jobId, leaseId);
      return;
    }
    jobManager.completeDirectJob(job.jobId, leaseId, { result });
  } catch (error) {
    if (error && error.code === "LEASE_EXPIRED") {
      // The ledger already resolved this attempt — cancellation finalized, or
      // the lease expired and recovery requeued the job for a fresh attempt.
      // There is nothing to fail; ack if a cancel is still pending and drop
      // the result.
      finalizeCancellation(job.jobId, leaseId);
      return;
    }
    try {
      jobManager.failDirectJob(job.jobId, leaseId, {
        errorCategory: error.code || "provider_error",
        errorMessage: error.message || "Provider execution failed",
      });
    } catch (completionError) {
      console.error(`[compute] failed to finalize direct job ${job.jobId}: ${redactSensitive(completionError.message)}`);
    }
  } finally {
    clearInterval(renewTimer);
    inFlight -= 1;
  }
}

async function runChatToCompletion(job, payload, leaseId) {
  const originalMessages = payload.messages || [{ role: "user", content: payload.prompt }];
  const messages = [...originalMessages];
  const parts = [];
  let result;
  let continuationCount = 0;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    // Poll between continuation rounds: a multi-round generation must not run
    // additional rounds after cancellation was requested. The caller's final
    // pre-publish check performs the actual discard/ack.
    if (attempt > 0 && cancellationRequested(job.jobId, leaseId)) break;
    result = await inferenceService.chat({
      messages,
      system: payload.system,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      contextLimit: payload.contextLimit,
      timeout: job.timeoutMs,
      dataClassification: job.dataClassification,
      preferences: { allowFallback: true },
    });
    if (result.content) parts.push(result.content);
    if (result.finishReason !== "length" || attempt === MAX_CONTINUATIONS) break;

    continuationCount += 1;
    messages.push(
      { role: "assistant", content: result.content || "" },
      { role: "user", content: "Continue exactly where you stopped. Do not repeat earlier content. Finish the answer completely, including any unfinished code block or section." },
    );
  }

  return {
    ...result,
    content: parts.join("\n\n"),
    continuationCount,
    complete: result.finishReason !== "length",
  };
}

function runOnce() {
  if (inFlight >= MAX_CONCURRENCY) return;
  const jobs = jobManager.listJobs({ status: "queued", limit: 50 })
    .filter(isDirectInferenceJob)
    .filter(job => !hasEligibleWorker(job));
  for (const job of jobs) {
    if (inFlight >= MAX_CONCURRENCY) break;
    let claimed;
    try {
      claimed = jobManager.claimDirectJob(job.jobId, { leaseDurationMs: DIRECT_LEASE_MS });
    } catch (e) {
      // Claim-time source materialization throws for an invalid handoff
      // (SOURCE_RESULT_MISSING / SOURCE_RESULT_TOO_LARGE / classification
      // mismatch). The job is still 'queued', so it cannot be failed through
      // the lease path — fail it terminally via the legal queued→failed
      // transition. Leaving it queued would re-throw on every poll tick.
      try {
        jobManager.transitionJob(job.jobId, "failed", {
          errorCategory: e.code || "direct_claim_failed",
          errorMessage: e.message || "Direct claim failed",
        });
      } catch (transitionError) {
        console.error(`[compute] could not fail unclaimable direct job ${job.jobId}: ${redactSensitive(transitionError.message)}`);
      }
      console.error(`[compute] direct job ${job.jobId} rejected at claim: ${redactSensitive(e.message)}`);
      continue;
    }
    if (!claimed) continue;
    inFlight += 1;
    void execute(claimed);
  }
}

// setInterval has no error boundary of its own: an uncaught throw inside the
// tick callback crashes the whole process. Every scheduled pass runs guarded.
function runOnceGuarded() {
  try { runOnce(); }
  catch (e) { console.error(`[compute] direct job runner pass failed: ${redactSensitive(e && e.message ? e.message : String(e))}`); }
}

function start() {
  if (timer) return;
  runOnceGuarded();
  timer = setInterval(runOnceGuarded, POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, runOnce, DIRECT_LEASE_MS };
