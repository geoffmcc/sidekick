"use strict";

// Two-phase cancellation regressions.
//
// cancelJob used to write 'cancelled' directly for EVERY non-terminal state,
// bypassing validateTransition (running→cancelled is not legal per errors.js)
// and leaving the declared 'cancelling' state dead code. The two-phase model:
//   - cancel of a live-leased executing job (starting/running) → 'cancelling';
//     the runner's cancellation poll observes it, aborts, and acknowledges,
//     and the ACK finalizes 'cancelled' (releasing lease + admission counter);
//   - queued/retry_wait/leased jobs cancel immediately, as before;
//   - a 'cancelling' job whose lease expires without an ack is finalized
//     'cancelled' by recovery.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-compute-cancellation");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";

delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
const compute = require("../src/compute");
const jobManager = require("../src/compute/job-manager");
const workerManager = require("../src/compute/worker-manager");
const { JOB_TRANSITIONS } = require("../src/compute/errors");

compute.initialize();
compute.stopReconciliation();

const db = dbStore.getDb();
const QWEN = "qwen3-embedding-0.6b-int8";

console.log("Running Compute Cancellation tests...\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack || e.message}`); }
}

function enrollWorker({ maxConcurrentJobs = 1, openvino = false } = {}) {
  const token = workerManager.createEnrollmentToken({
    displayName: "cancel-test-worker", trustLevel: "trusted", maxConcurrentJobs,
  });
  const executors = [{ type: "mock.inference", capabilities: ["chat"] }];
  if (openvino) executors.push({ type: "openvino.text_embedding", capabilities: [`openvino.text_embedding:${QWEN}:NPU:seq512:batch1:certified`] });
  const enrolled = workerManager.enrollWorker({
    nodeId: "cancel-node-" + Math.random().toString(36).slice(2, 8),
    displayName: "cancel-test-worker",
    platform: "linux",
    enrollmentToken: token.token,
    executors,
    modelInventory: openvino ? [{ name: QWEN, device: "NPU", certificationTier: "certified" }] : [],
  });
  workerManager.updateWorker(enrolled.workerId, { state: "online", connectionState: "online" });
  return workerManager.getWorker(enrolled.workerId);
}

function offlineAllWorkers() {
  for (const w of workerManager.listWorkers()) {
    workerManager.updateWorker(w.workerId, { state: "offline", connectionState: "offline" });
  }
}

function makeChatJob() {
  return jobManager.createJob({
    jobType: "chat", capability: "chat", source: "test",
    dataClassification: "private", requestPayload: { prompt: "x" },
  });
}

function claimAndStart(worker) {
  const job = makeChatJob();
  const claim = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.ok(claim, "job claimed");
  jobManager.startLeasedJob(job.jobId, worker.workerId, claim.leaseId);
  return { job, claim };
}

console.log("CC.1: transition legality");

test("the declared state machine still forbids running→cancelled and allows the two-phase path", () => {
  assert.ok(!JOB_TRANSITIONS.running.includes("cancelled"), "running→cancelled stays illegal");
  assert.ok(JOB_TRANSITIONS.running.includes("cancelling"), "running→cancelling legal");
  assert.ok(JOB_TRANSITIONS.cancelling.includes("cancelled"), "cancelling→cancelled legal");
});

console.log("\nCC.2: immediate cancellation for non-executing jobs (unchanged behaviour)");

test("queued job cancels immediately", () => {
  const job = makeChatJob();
  const cancelled = jobManager.cancelJob(job.jobId, { reason: "queued-cancel" });
  assert.strictEqual(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelledAt, "cancelled_at recorded");
});

test("leased-but-not-started job cancels immediately and frees the worker counter", () => {
  const worker = enrollWorker({});
  makeChatJob();
  const claim = jobManager.claimNextJob(worker, {});
  assert.ok(claim, "claimed");
  const cancelled = jobManager.cancelJob(claim.job.jobId, { reason: "leased-cancel" });
  assert.strictEqual(cancelled.status, "cancelled", "leased→cancelled is legal and immediate");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0, "counter freed");
  offlineAllWorkers();
});

console.log("\nCC.3: two-phase cancellation for live-leased execution");

test("cancel of a running job requests 'cancelling'; the worker's ack finalizes 'cancelled'", () => {
  const worker = enrollWorker({});
  const { job, claim } = claimAndStart(worker);

  const requested = jobManager.cancelJob(job.jobId, { actor: "tester", reason: "two-phase" });
  assert.strictEqual(requested.status, "cancelling", "live-leased running job enters cancelling");
  assert.ok(requested.cancelRequestedAt, "request recorded");
  assert.strictEqual(requested.cancelledAt, null, "not yet terminal");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 1,
    "counter is NOT freed at request time — the worker still holds the lease");

  // The worker's poll sees the request and may keep renewing while aborting.
  const status = jobManager.getCancellationStatus(job.jobId, worker.workerId, claim.leaseId);
  assert.strictEqual(status.cancelled, true, "cancellation poll observes the request");
  assert.throws(() => jobManager.renewLease(job.jobId, "wk_attacker", claim.leaseId, 300000), /Lease expired|lease/i,
    "a different authenticated worker must not renew this worker's lease");
  jobManager.renewLease(job.jobId, claim.leaseId);

  // Repeated admin cancel must not force-finalize under the runner.
  assert.strictEqual(jobManager.cancelJob(job.jobId, { reason: "again" }).status, "cancelling");

  const acked = jobManager.acknowledgeCancellation(job.jobId, worker.workerId, claim.leaseId);
  assert.strictEqual(acked.status, "cancelled", "ack finalizes the cancel");
  assert.ok(acked.cancelAcknowledgedAt, "ack recorded");
  assert.strictEqual(acked.leaseId, null, "lease released at finalization");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0, "counter freed at finalization");
  const attempt = jobManager.listAttempts(job.jobId).pop();
  assert.strictEqual(attempt.status, "cancelled", "attempt row finalized");
  offlineAllWorkers();
});

test("a worker that finished before observing the cancel may still complete (legal transition)", () => {
  const worker = enrollWorker({});
  const { job, claim } = claimAndStart(worker);
  jobManager.cancelJob(job.jobId, { reason: "raced-with-completion" });
  const completed = jobManager.completeJob(job.jobId, worker.workerId, claim.leaseId, {
    result: { content: "finished before the poll saw it" },
  });
  assert.strictEqual(completed.status, "completed", "cancelling→completed is the declared race outcome");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0);
  offlineAllWorkers();
});

test("a failure reported while cancelling finalizes the cancel, not a retry", () => {
  const worker = enrollWorker({});
  const { job, claim } = claimAndStart(worker);
  jobManager.cancelJob(job.jobId, { reason: "abort" });
  const finalized = jobManager.failJob(job.jobId, worker.workerId, claim.leaseId, {
    errorCategory: "worker_error", errorMessage: "aborted mid-generation",
  });
  assert.strictEqual(finalized.status, "cancelled", "cancel wins; cancelling→retry_wait would be illegal");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0);
  offlineAllWorkers();
});

test("a cancelling job whose lease expires without an ack is finalized by recovery", () => {
  const worker = enrollWorker({});
  const { job } = claimAndStart(worker);
  jobManager.cancelJob(job.jobId, { reason: "worker-vanished" });
  db.prepare("UPDATE compute_jobs SET lease_expires_at = ? WHERE job_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), job.jobId);
  assert.strictEqual(jobManager.recoverExpiredLeases(), 1, "recovery handles the cancelling row");
  const final = jobManager.getJob(job.jobId);
  assert.strictEqual(final.status, "cancelled", "finalized cancelled, never requeued");
  assert.strictEqual(final.leaseId, null);
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0, "counter freed by recovery");
  offlineAllWorkers();
});

console.log("\nCC.4: cancelling counts as active everywhere admission is decided");

test("per-executor concurrency still counts a cancelling OpenVINO job", () => {
  offlineAllWorkers();
  db.prepare("DELETE FROM compute_jobs").run();
  const worker = enrollWorker({ maxConcurrentJobs: 2, openvino: true });
  const jobA = jobManager.createJob({
    jobType: "text_embedding", capability: "openvino.text_embedding", source: "test",
    dataClassification: "private",
    capabilityRequirements: { executor: "openvino.text_embedding" },
    requestPayload: { input: "a", model: QWEN },
  });
  const claimA = jobManager.claimNextJob(worker, {});
  assert.ok(claimA, "first openvino job claimed");
  jobManager.startLeasedJob(jobA.jobId, worker.workerId, claimA.leaseId);
  jobManager.cancelJob(jobA.jobId, { reason: "hold-the-slot" });
  assert.strictEqual(jobManager.getJob(jobA.jobId).status, "cancelling");

  jobManager.createJob({
    jobType: "text_embedding", capability: "openvino.text_embedding", source: "test",
    dataClassification: "private",
    capabilityRequirements: { executor: "openvino.text_embedding" },
    requestPayload: { input: "b", model: QWEN },
  });
  const claimB = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.strictEqual(claimB, null,
    "the resident-model executor slot is still held until the cancel is acknowledged");

  jobManager.acknowledgeCancellation(jobA.jobId, worker.workerId, claimA.leaseId);
  const claimAfter = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.ok(claimAfter, "slot frees after the ack");
  offlineAllWorkers();
});

test("job stats count a cancelling lease as active", () => {
  offlineAllWorkers();
  db.prepare("DELETE FROM compute_jobs").run();
  const worker = enrollWorker({});
  const { job } = claimAndStart(worker);
  jobManager.cancelJob(job.jobId, { reason: "stats" });
  assert.strictEqual(jobManager.getJobStats().activeLeases, 1, "cancelling lease is active");
  assert.strictEqual(jobManager.getJobStats().byStatus.cancelling, 1);
  offlineAllWorkers();
});

console.log(`\nCompute Cancellation tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
