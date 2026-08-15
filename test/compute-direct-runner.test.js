"use strict";

// Direct job runner production-completion regressions:
//
// 1. PROCESS CRASH — claimDirectJob materializes the source handoff at claim
//    time and can throw (SOURCE_RESULT_MISSING/TOO_LARGE); uncaught inside the
//    poll tick this killed the whole process. The poisoned job must fail
//    terminally and the runner must survive.
// 2. STRANDED ASYNC JOBS — the direct lease used to be max(timeoutMs+60s, 15m)
//    (~24h with the async tool default), and an interrupted attempt at
//    attempt==max_attempts dead-lettered. The lease is now capped at 5 minutes
//    and renewed from execute(); an interrupted attempt (no reported outcome)
//    requeues with the attempt refunded, bounded by an interruption cap.
// 3. DIRECT CANCELLATION — cancel of a live direct job goes through the
//    two-phase cancelling state; the runner observes it, discards the result
//    cleanly, and acknowledges (no LeaseExpiredError→failDirectJob noise).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-compute-direct-runner");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";

delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
const compute = require("../src/compute");
const jobManager = require("../src/compute/job-manager");
const inferenceService = require("../src/compute/inference-service");
const directJobRunner = require("../src/compute/direct-job-runner");

compute.initialize();
compute.stopReconciliation(); // stop timers; every pass below is driven manually

const db = dbStore.getDb();

console.log("Running Compute Direct Runner tests...\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack || e.message}`); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(predicate, timeoutMs = 3000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeAsyncChatJob(extraPayload = {}, extra = {}) {
  return jobManager.createJob({
    jobType: "chat",
    capability: "chat",
    source: "test",
    project: "direct-runner-test",
    dataClassification: "private",
    requestPayload: { async: true, prompt: "hello", ...extraPayload },
    timeoutMs: 86400000, // the async tool default that produced ~24h leases
    maxAttempts: 1,
    ...extra,
  });
}

(async () => {
  await test("claim-time source error fails the job terminally instead of crashing the poll tick", async () => {
    // A completed source job with NO textual content makes materializeSourceJob
    // throw SOURCE_RESULT_MISSING at claim time.
    const source = jobManager.createJob({
      jobType: "chat", capability: "chat", source: "test", project: "direct-runner-test",
      dataClassification: "private", requestPayload: { prompt: "src" },
    });
    jobManager.transitionJob(source.jobId, "leased");
    jobManager.transitionJob(source.jobId, "starting");
    jobManager.transitionJob(source.jobId, "running");
    jobManager.transitionJob(source.jobId, "completed", { result: { notContent: true } });

    const poisoned = makeAsyncChatJob({ sourceJobId: source.jobId });
    // Must not throw — this is the exact call the setInterval tick makes.
    directJobRunner.runOnce();
    const failedJob = jobManager.getJob(poisoned.jobId);
    assert.strictEqual(failedJob.status, "failed", "poisoned job fails terminally");
    assert.strictEqual(failedJob.errorCategory, "SOURCE_RESULT_MISSING");
    // A second pass must not find it queued again (no hot loop).
    directJobRunner.runOnce();
    assert.strictEqual(jobManager.getJob(poisoned.jobId).status, "failed");
  });

  await test("direct claims use the capped 5-minute lease, not timeoutMs+60s", async () => {
    const job = makeAsyncChatJob();
    let captured = null;
    const original = jobManager.claimDirectJob;
    jobManager.claimDirectJob = (jobId, opts) => { captured = { jobId, ...opts }; return null; };
    try { directJobRunner.runOnce(); } finally { jobManager.claimDirectJob = original; }
    assert.ok(captured, "runner attempted a claim");
    assert.strictEqual(captured.leaseDurationMs, directJobRunner.DIRECT_LEASE_MS, "lease is the capped constant");
    assert.ok(directJobRunner.DIRECT_LEASE_MS <= 5 * 60 * 1000, "cap is at most five minutes");
    jobManager.cancelJob(job.jobId, { reason: "test-cleanup" });
  });

  await test("interrupted attempt on 1-of-1 requeues with the attempt refunded (not dead_letter)", async () => {
    const job = makeAsyncChatJob();
    const claimed = jobManager.claimDirectJob(job.jobId, { leaseDurationMs: directJobRunner.DIRECT_LEASE_MS });
    assert.ok(claimed, "job claimed");
    assert.strictEqual(jobManager.getJob(job.jobId).attempt, 1, "attempt consumed by the claim");

    // Simulate a crash: the lease lapses with no reported outcome.
    db.prepare("UPDATE compute_jobs SET lease_expires_at = ? WHERE job_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), job.jobId);
    assert.strictEqual(jobManager.recoverExpiredLeases(), 1, "recovery reclaims the lease");

    const recovered = jobManager.getJob(job.jobId);
    assert.strictEqual(recovered.status, "retry_wait", "interrupted final attempt requeues, never dead-letters");
    assert.strictEqual(recovered.attempt, 0, "the attempt that never reported is refunded");
    assert.strictEqual(recovered.errorCategory, "lease_expired");

    // The refund is what makes the job actually claimable again under the
    // claim guard (status='queued' AND attempt < max_attempts).
    db.prepare("UPDATE compute_jobs SET retry_after = ? WHERE job_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), job.jobId);
    jobManager.releaseRetryWaitJobs();
    assert.strictEqual(jobManager.getJob(job.jobId).status, "queued");
    const reclaimed = jobManager.claimDirectJob(job.jobId, { leaseDurationMs: directJobRunner.DIRECT_LEASE_MS });
    assert.ok(reclaimed, "refunded job is claimable for a replacement attempt");
    jobManager.completeDirectJob(job.jobId, reclaimed.leaseId, { result: { content: "ok" } });
  });

  await test("repeated interruptions are bounded: the cap dead-letters a crash-looping job", async () => {
    const job = makeAsyncChatJob();
    let status;
    for (let i = 0; i < 4; i++) {
      const claimed = jobManager.claimDirectJob(job.jobId, { leaseDurationMs: directJobRunner.DIRECT_LEASE_MS });
      assert.ok(claimed, `claim #${i + 1} succeeds`);
      db.prepare("UPDATE compute_jobs SET lease_expires_at = ? WHERE job_id = ?")
        .run(new Date(Date.now() - 1000).toISOString(), job.jobId);
      jobManager.recoverExpiredLeases();
      status = jobManager.getJob(job.jobId).status;
      if (status === "dead_letter") break;
      db.prepare("UPDATE compute_jobs SET retry_after = ? WHERE job_id = ?")
        .run(new Date(Date.now() - 1000).toISOString(), job.jobId);
      jobManager.releaseRetryWaitJobs();
    }
    assert.strictEqual(status, "dead_letter", "the interruption cap ends the crash loop");
    assert.strictEqual(jobManager.getJob(job.jobId).errorCategory, "attempts_exhausted");
  });

  // --- Behavioral runner tests with a controllable inference service ---
  const originalChat = inferenceService.chat;

  await test("runner completes a healthy async chat job (guards intact)", async () => {
    inferenceService.chat = async () => ({ content: "direct answer", model: "m", finishReason: "stop" });
    const job = makeAsyncChatJob();
    directJobRunner.runOnce();
    const done = await waitFor(() => {
      const j = jobManager.getJob(job.jobId);
      return j.status === "completed" ? j : null;
    }, 3000, "job completion");
    assert.strictEqual(done.result.content, "direct answer");
  });

  await test("cancel during generation: result discarded cleanly, two-phase ack, no failure noise", async () => {
    let resolveChat;
    let chatCalls = 0;
    inferenceService.chat = () => { chatCalls++; return new Promise(res => { resolveChat = res; }); };
    const job = makeAsyncChatJob();
    directJobRunner.runOnce();
    await waitFor(() => jobManager.getJob(job.jobId).status === "running", 3000, "job running");

    const cancelling = jobManager.cancelJob(job.jobId, { actor: "test", reason: "user-cancel" });
    assert.strictEqual(cancelling.status, "cancelling", "live direct job enters the two-phase cancelling state");

    // The model "finishes" after the cancel arrived; the runner must discard.
    resolveChat({ content: "too late", model: "m", finishReason: "stop" });
    const final = await waitFor(() => {
      const j = jobManager.getJob(job.jobId);
      return j.status === "cancelled" ? j : null;
    }, 3000, "cancellation finalization");
    assert.strictEqual(final.result, null, "cancelled job publishes no result");
    assert.ok(final.cancelAcknowledgedAt, "runner acknowledged the cancellation");
    assert.strictEqual(final.leaseId, null, "lease released at finalization");
    assert.strictEqual(chatCalls, 1);
  });

  await test("cancel between continuation rounds stops further rounds", async () => {
    let resolveChat;
    let chatCalls = 0;
    inferenceService.chat = () => { chatCalls++; return new Promise(res => { resolveChat = res; }); };
    const job = makeAsyncChatJob();
    directJobRunner.runOnce();
    await waitFor(() => jobManager.getJob(job.jobId).status === "running", 3000, "job running");
    jobManager.cancelJob(job.jobId, { actor: "test", reason: "mid-continuation" });

    // First round returns truncated output that would normally trigger a
    // continuation round; the between-round poll must break instead.
    resolveChat({ content: "part 1", model: "m", finishReason: "length" });
    const final = await waitFor(() => {
      const j = jobManager.getJob(job.jobId);
      return j.status === "cancelled" ? j : null;
    }, 3000, "cancellation finalization");
    assert.strictEqual(chatCalls, 1, "no continuation round ran after the cancel");
    assert.strictEqual(final.result, null);
  });

  inferenceService.chat = originalChat;

  console.log(`\nCompute Direct Runner tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error("Fatal:", e); process.exit(1); });
