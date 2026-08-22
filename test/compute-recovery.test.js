"use strict";

// Compute reliability regressions:
//
// Issue #150 — expired-lease recovery must run on the reconciliation timer,
// not depend on incidental API traffic: a dead worker's jobs return to a
// claimable state within the documented cadence, including the second-order
// retry_wait → queued promotion.
//
// Issue #148 — a worker heartbeat must never overwrite the transactionally
// maintained current_jobs admission counter with its self-reported value;
// the counter is reconciled from the jobs table instead.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-compute-recovery");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";

delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
const compute = require("../src/compute");
const jobManager = require("../src/compute/job-manager");
const workerManager = require("../src/compute/worker-manager");
const { LeaseExpiredError } = require("../src/compute/errors");

console.log("Running Compute Recovery tests...\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

compute.initialize();
compute.stopReconciliation();

const QWEN = "qwen3-embedding-0.6b-int8";

function enrollWorker({ maxConcurrentJobs = 1 } = {}) {
  const token = workerManager.createEnrollmentToken({
    displayName: "recovery-test-worker",
    trustLevel: "trusted",
    maxConcurrentJobs,
  });
  const enrolled = workerManager.enrollWorker({
    nodeId: "recovery-node-" + Math.random().toString(36).slice(2, 8),
    displayName: "recovery-test-worker",
    platform: "linux",
    enrollmentToken: token.token,
    executors: [
      { type: "mock.inference" },
      { type: "openvino.text_embedding", capabilities: [`openvino.text_embedding:${QWEN}:NPU:seq512:batch1:certified`] },
    ],
    modelInventory: [{ name: QWEN, device: "NPU", certificationTier: "certified" }],
  });
  workerManager.updateWorker(enrolled.workerId, { state: "online", connectionState: "online" });
  return workerManager.getWorker(enrolled.workerId);
}

function makeJob() {
  return jobManager.createJob({
    jobType: "text_embedding",
    capability: "openvino.text_embedding",
    source: "test",
    dataClassification: "private",
    capabilityRequirements: { executor: "openvino.text_embedding" },
    requestPayload: { input: "hello world", model: QWEN },
  });
}

// The openvino executor is capped at one concurrent job per worker, so tests
// that need two simultaneous claims pair it with a mock.inference job.
function makeMockJob() {
  return jobManager.createJob({
    jobType: "embeddings",
    capability: "embeddings",
    source: "test",
    dataClassification: "private",
    requestPayload: { input: "x" },
  });
}

function offlineAllWorkers() {
  for (const w of workerManager.listWorkers()) {
    workerManager.updateWorker(w.workerId, { state: "offline", connectionState: "offline" });
  }
}

// Runs one scheduled reconciliation pass exactly as the timer would: the
// immediate pass inside startReconciliation IS the timer body.
function runScheduledPass() {
  compute.startReconciliation();
  compute.stopReconciliation();
}

const db = dbStore.getDb();

console.log("CR.1: scheduled recovery (issue #150)");

test("queued jobs with elapsed deadlines become terminal expired jobs", () => {
  const explicit = jobManager.createJob({
    jobType: "text_embedding",
    capability: "openvino.text_embedding",
    source: "test",
    requestPayload: { input: "expired", model: QWEN },
    capabilityRequirements: { executor: "openvino.text_embedding" },
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const timed = jobManager.createJob({
    jobType: "text_embedding",
    capability: "openvino.text_embedding",
    source: "test",
    requestPayload: { input: "timed", model: QWEN },
    capabilityRequirements: { executor: "openvino.text_embedding" },
    timeoutMs: 1000,
  });
  db.prepare("UPDATE compute_jobs SET created_at = ? WHERE job_id = ?")
    .run(new Date(Date.now() - 2000).toISOString(), timed.jobId);

  assert.strictEqual(jobManager.expireQueuedJobs(), 2, "both elapsed deadlines transition once");
  for (const id of [explicit.jobId, timed.jobId]) {
    const expired = jobManager.getJob(id);
    assert.strictEqual(expired.status, "expired");
    assert.strictEqual(expired.errorCategory, "expired");
  }
});

test("an expired lease is reclaimed by the reconciliation pass alone", () => {
  const worker = enrollWorker({});
  const job = makeJob();
  const claim = jobManager.claimNextJob(worker, {});
  assert.ok(claim, "job is claimable");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 1, "claim increments the counter");

  db.prepare("UPDATE compute_jobs SET lease_expires_at = ? WHERE job_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), job.jobId);

  runScheduledPass();

  const recovered = jobManager.getJob(job.jobId);
  assert.strictEqual(recovered.status, "retry_wait", "expired lease returns the job to retry_wait");
  assert.strictEqual(recovered.leaseId, null, "lease is cleared");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0, "recovery decrements the counter");
  offlineAllWorkers();
});

test("retry_wait jobs are requeued by the reconciliation pass alone", () => {
  const stuck = db.prepare("SELECT job_id FROM compute_jobs WHERE status = 'retry_wait'").all();
  assert.ok(stuck.length >= 1, "previous test left a retry_wait job");
  db.prepare("UPDATE compute_jobs SET retry_after = ? WHERE status = 'retry_wait'")
    .run(new Date(Date.now() - 1000).toISOString());

  runScheduledPass();

  for (const row of stuck) {
    assert.strictEqual(jobManager.getJob(row.job_id).status, "queued",
      "retry_wait promotes to queued without any claim traffic");
  }
});

test("recovery is idempotent: one decrement per expired lease, stale renewals fail loudly", () => {
  offlineAllWorkers();
  db.prepare("DELETE FROM compute_jobs").run();
  const worker = enrollWorker({ maxConcurrentJobs: 2 });
  makeJob();
  const claimA = jobManager.claimNextJob(worker, {});
  makeMockJob();
  const claimB = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.ok(claimA && claimB, "both jobs claimed");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 2);

  db.prepare("UPDATE compute_jobs SET lease_expires_at = ? WHERE job_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), claimA.job.jobId);

  assert.strictEqual(jobManager.recoverExpiredLeases(), 1, "first pass recovers the expired lease");
  assert.strictEqual(jobManager.recoverExpiredLeases(), 0, "second pass matches nothing (guarded update)");
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 1,
    "exactly one decrement even when recovery runs twice");

  assert.throws(() => jobManager.renewLease(claimA.job.jobId, claimA.leaseId), LeaseExpiredError,
    "a lease nulled by recovery cannot be silently renewed");

  jobManager.completeJob(claimB.job.jobId, worker.workerId, claimB.leaseId, {
    result: { embedding: [0.1], device: "NPU", fallback_occurred: false },
  });
  offlineAllWorkers();
});

console.log("\nCR.2: heartbeat cannot corrupt admission control (issue #148)");

test("a zero heartbeat cannot reset the counter of a busy worker", () => {
  offlineAllWorkers();
  db.prepare("DELETE FROM compute_jobs").run();
  const worker = enrollWorker({ maxConcurrentJobs: 1 });
  const job = makeJob();
  const claim = jobManager.claimNextJob(worker, {});
  assert.ok(claim, "job is claimable");

  workerManager.heartbeat(worker.workerId, { currentJobs: 0 });
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 1,
    "counter reconciles to the real active-job count, not the reported zero");

  makeJob();
  const overCap = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.strictEqual(overCap, null, "admission control still refuses a second claim at capacity");

  jobManager.completeJob(job.jobId, worker.workerId, claim.leaseId, {
    result: { embedding: [0.1], device: "NPU", fallback_occurred: false },
  });
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0, "completion decrements");

  workerManager.heartbeat(worker.workerId, { currentJobs: 99 });
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0,
    "an inflated report cannot manufacture load either");
  offlineAllWorkers();
});

test("heartbeat reconciliation self-heals counter drift", () => {
  offlineAllWorkers();
  db.prepare("DELETE FROM compute_jobs").run();
  const worker = enrollWorker({ maxConcurrentJobs: 2 });
  db.prepare("UPDATE compute_workers SET current_jobs = 5 WHERE worker_id = ?").run(worker.workerId);

  workerManager.heartbeat(worker.workerId, { currentJobs: 5 });
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 0,
    "drifted counter reconciles back to the real count on heartbeat");

  const job = makeJob();
  const claim = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.ok(claim, "worker is claimable again after self-heal");
  jobManager.completeJob(job.jobId, worker.workerId, claim.leaseId, {
    result: { embedding: [0.1], device: "NPU", fallback_occurred: false },
  });
  offlineAllWorkers();
});

test("job completion persists fresh telemetry before exposing terminal state", () => {
  offlineAllWorkers();
  db.prepare("DELETE FROM compute_jobs").run();
  const worker = enrollWorker();
  const job = makeJob();
  const claim = jobManager.claimNextJob(worker, {});
  assert.ok(claim, "job is claimable");

  const completed = jobManager.completeJob(job.jobId, worker.workerId, claim.leaseId, {
    result: { embedding: [0.1] },
    telemetry: {
      privacy: "external-ok",
      gpu: { status: "available", devices: [{ name: "Fresh GPU", utilizationPercent: 77, pid: 9 }] },
      inference: { status: "available", model: "fresh-model", prompt: "must not persist" },
    },
  });
  assert.strictEqual(completed.status, "completed");
  const observed = workerManager.getWorker(worker.workerId).telemetry;
  assert.strictEqual(observed.gpu.devices[0].name, "Fresh GPU");
  assert.strictEqual(observed.gpu.devices[0].utilizationPercent, 77);
  assert.strictEqual(observed.privacy, "local-only");
  assert.ok(!JSON.stringify(observed).includes("must not persist"));
  offlineAllWorkers();
});

test("a heartbeat without a job report leaves the counter alone", () => {
  offlineAllWorkers();
  const worker = enrollWorker({});
  db.prepare("UPDATE compute_workers SET current_jobs = 1 WHERE worker_id = ?").run(worker.workerId);
  workerManager.heartbeat(worker.workerId, { utilization: { cpu: 10 } });
  assert.strictEqual(workerManager.getWorker(worker.workerId).currentJobs, 1,
    "credential probes that omit currentJobs must not touch the counter");
  offlineAllWorkers();
});

console.log("\nCompute Recovery tests: " + passed + " passed, " + failed + " failed\n");
if (failed > 0) process.exit(1);
