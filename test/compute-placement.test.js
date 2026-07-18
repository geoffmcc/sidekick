"use strict";

// Compute Placement v1 tests: shared decision core, certified-NPU embedding
// placement, policy-gated fallback, trust/data-classification enforcement on
// BOTH routing paths, per-executor concurrency, accelerator provenance, and
// explain/dry-run parity. No live hardware, model, or network required (the
// only sockets used are refused-connection localhost probes).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-placement");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";

delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
const compute = require("../src/compute");
const placement = require("../src/compute/placement");
const providerRegistry = require("../src/compute/provider-registry");
const modelRegistry = require("../src/compute/model-registry");
const jobManager = require("../src/compute/job-manager");
const workerManager = require("../src/compute/worker-manager");
const inferenceService = require("../src/compute/inference-service");
const { LeaseExpiredError } = require("../src/compute/errors");

console.log("Running Compute Placement v1 tests...\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}
// Async tests are queued and awaited sequentially so DB state never overlaps.
const asyncQueue = [];
function testAsync(name, fn) {
  asyncQueue.push({ name, fn });
}

compute.initialize();

// ---- helpers ----------------------------------------------------------------

const QWEN = "qwen3-embedding-0.6b-int8";

function enrollTestWorker({ allowedDataClassifications, maxConcurrentJobs = 2, trustLevel = "trusted", executors, modelInventory } = {}) {
  const token = workerManager.createEnrollmentToken({
    displayName: "placement-test-worker",
    trustLevel,
    ...(allowedDataClassifications ? { allowedDataClassifications } : {}),
    maxConcurrentJobs,
  });
  const enrolled = workerManager.enrollWorker({
    nodeId: "placement-node-" + Math.random().toString(36).slice(2, 8),
    displayName: "placement-test-worker",
    platform: "linux",
    enrollmentToken: token.token,
    executors: executors || [
      { type: "mock.inference" },
      { type: "openvino.text_embedding", capabilities: [`openvino.text_embedding:${QWEN}:NPU:seq512:batch1:certified`] },
    ],
    modelInventory: modelInventory || [{ name: QWEN, device: "NPU", certificationTier: "certified" }],
  });
  workerManager.updateWorker(enrolled.workerId, { state: "online", connectionState: "online" });
  return workerManager.getWorker(enrolled.workerId);
}

function offlineAllWorkers() {
  for (const w of workerManager.listWorkers()) {
    workerManager.updateWorker(w.workerId, { state: "offline", connectionState: "offline" });
  }
}

function embeddingRequest(overrides = {}) {
  return {
    version: 1,
    capability: "embeddings",
    data_classification: "private",
    ...overrides,
  };
}

function makeOpenvinoJob({ dataClassification = "private", sequenceLength, model = QWEN } = {}) {
  return jobManager.createJob({
    jobType: "text_embedding",
    capability: "openvino.text_embedding",
    source: "test",
    dataClassification,
    capabilityRequirements: { executor: "openvino.text_embedding", ...(sequenceLength ? { sequence_length: sequenceLength } : {}) },
    requestPayload: { input: "hello world", model },
  });
}

// ---- request schema (fail-closed) -------------------------------------------

test("unknown capability is rejected", () => {
  assert.throws(() => placement.validatePlacementRequest({ capability: "shell", data_classification: "private" }), /Unsupported placement capability/);
});

test("missing data_classification is rejected (no fail-open default)", () => {
  assert.throws(() => placement.validatePlacementRequest({ capability: "chat" }), /data_classification is required/);
});

test("unknown top-level field is rejected", () => {
  assert.throws(() => placement.validatePlacementRequest({ capability: "chat", data_classification: "private", worker_id: "wk_1" }), /Unknown field/);
});

test("unknown requirement/preference fields are rejected", () => {
  assert.throws(() => placement.validatePlacementRequest({ capability: "chat", data_classification: "private", requirements: { gpu: true } }), /Unknown field/);
  assert.throws(() => placement.validatePlacementRequest({ capability: "chat", data_classification: "private", preferences: { provider_id: "p" } }), /Unknown field/);
});

test("unsupported version is rejected", () => {
  assert.throws(() => placement.validatePlacementRequest({ version: 2, capability: "chat", data_classification: "private" }), /version/);
});

test("job creation rejects endpoint/credential/device/worker/trust/provenance fields", () => {
  const forbidden = [
    { requestPayload: { input: "x", endpoint: "http://evil" } },
    { requestPayload: { input: "x", credentials: { key: "v" } } },
    { requestPayload: { input: "x", device: "NPU" } },
    { capabilityRequirements: { worker_id: "wk_1" } },
    { routingPreferences: { trust_level: "privileged" } },
    { requestPayload: { input: "x", fallback_occurred: false } },
  ];
  for (const extra of forbidden) {
    assert.throws(
      () => jobManager.createJob({ jobType: "embeddings", capability: "embeddings", requestPayload: { input: "x" }, ...extra }),
      /not permitted/,
      "should reject " + JSON.stringify(extra)
    );
  }
});

// ---- certified NPU embedding placement --------------------------------------

const npuWorker = enrollTestWorker();

test("healthy certified NPU embedding placement is preferred", () => {
  const decision = placement.decidePlacement(embeddingRequest());
  assert.ok(decision.selected, "a candidate must be selected");
  assert.strictEqual(decision.selected.worker_id, npuWorker.workerId);
  assert.strictEqual(decision.selected.executor, "openvino.text_embedding");
  assert.strictEqual(decision.selected.accelerator, "NPU");
  assert.strictEqual(decision.selected.execution_path, "worker_job");
  assert.strictEqual(decision.reason, "preferred_certified_npu_embedding");
});

test("permitted CPU fallback is offered with same-model policy", () => {
  const decision = placement.decidePlacement(embeddingRequest({ preferences: { allow_fallback: true } }));
  const cpu = decision.fallbacks.find(f => f.accelerator === "CPU");
  assert.ok(cpu, "CPU fallback should be listed");
  assert.strictEqual(cpu.policy, "same_model_cpu");
  assert.strictEqual(cpu.reason, "npu_unavailable");
});

test("fallback disabled records fallback_disabled instead of a fallback", () => {
  const decision = placement.decidePlacement(embeddingRequest({ preferences: { allow_fallback: false } }));
  assert.strictEqual(decision.fallbacks.length, 0, "no fallbacks when disabled");
  assert.ok(decision.rejected.some(r => r.reasons?.includes("fallback_disabled")), "fallback_disabled recorded");
});

test("static-shape incompatibility rejects the certified path", () => {
  const decision = placement.decidePlacement(embeddingRequest({ requirements: { sequence_length: 999 } }));
  assert.ok(!decision.selected || decision.selected.executor !== "openvino.text_embedding", "non-certified shape must not select the OpenVINO path");
  assert.ok(decision.rejected.some(r => r.reasons?.includes("static_shape_required")));
});

test("dimension mismatch rejects the certified path", () => {
  const decision = placement.decidePlacement(embeddingRequest({ requirements: { dimensions: 42 } }));
  assert.ok(!decision.selected || decision.selected.executor !== "openvino.text_embedding");
  assert.ok(decision.rejected.some(r => r.reasons?.includes("dimensions_mismatch")));
});

test("stale worker is rejected with worker_stale", () => {
  const db = dbStore.getDb();
  db.prepare("UPDATE compute_workers SET last_heartbeat = ? WHERE worker_id = ?")
    .run(new Date(Date.now() - 10 * 60000).toISOString(), npuWorker.workerId);
  const decision = placement.decidePlacement(embeddingRequest());
  assert.ok(!decision.selected || decision.selected.worker_id !== npuWorker.workerId);
  assert.ok(decision.rejected.some(r => r.reasons?.includes("worker_stale")));
  db.prepare("UPDATE compute_workers SET last_heartbeat = ? WHERE worker_id = ?").run(new Date().toISOString(), npuWorker.workerId);
});

test("offline worker is rejected with worker_offline", () => {
  workerManager.updateWorker(npuWorker.workerId, { state: "offline", connectionState: "offline" });
  const decision = placement.decidePlacement(embeddingRequest());
  assert.ok(decision.rejected.some(r => r.reasons?.includes("worker_offline")));
  workerManager.updateWorker(npuWorker.workerId, { state: "online", connectionState: "online" });
});

test("worker concurrency exhaustion is rejected", () => {
  const db = dbStore.getDb();
  db.prepare("UPDATE compute_workers SET current_jobs = max_concurrent_jobs WHERE worker_id = ?").run(npuWorker.workerId);
  const decision = placement.decidePlacement(embeddingRequest());
  assert.ok(decision.rejected.some(r => r.reasons?.includes("concurrency_exhausted")));
  db.prepare("UPDATE compute_workers SET current_jobs = 0 WHERE worker_id = ?").run(npuWorker.workerId);
});

test("exact model missing from inventory is rejected", () => {
  const bare = enrollTestWorker({ modelInventory: [{ name: "some-other-model" }] });
  const evaluation = placement.evaluateWorkerCandidate(
    placement.validatePlacementRequest(embeddingRequest()),
    bare, { executor: "openvino.text_embedding", model: QWEN }
  );
  assert.ok(evaluation.reasons.includes("model_missing"));
  workerManager.updateWorker(bare.workerId, { state: "offline", connectionState: "offline" });
});

// ---- worker trust / classification / certification forgery ------------------

test("enrollment token data classifications are persisted and enforced", () => {
  const scoped = enrollTestWorker({ allowedDataClassifications: ["public"] });
  assert.deepStrictEqual(scoped.allowedDataClassifications, ["public"], "token scope must persist on the worker row");
  const evaluation = placement.evaluateWorkerCandidate(
    placement.validatePlacementRequest(embeddingRequest()), // private
    scoped, { executor: "openvino.text_embedding", model: QWEN }
  );
  assert.ok(evaluation.reasons.includes("data_classification_denied"));
  workerManager.updateWorker(scoped.workerId, { state: "offline", connectionState: "offline" });
});

test("worker trust below the required floor is rejected", () => {
  const lowTrust = enrollTestWorker({ trustLevel: "limited" });
  const evaluation = placement.evaluateWorkerCandidate(
    placement.validatePlacementRequest(embeddingRequest({ trust_level_required: "trusted" })),
    lowTrust, { executor: "openvino.text_embedding", model: QWEN }
  );
  assert.ok(evaluation.reasons.includes("trust_too_low"));
  workerManager.updateWorker(lowTrust.workerId, { state: "offline", connectionState: "offline" });
});

test("worker cannot forge certification for a non-manifest model", () => {
  const forger = enrollTestWorker({
    executors: [{ type: "openvino.text_embedding", capabilities: ["openvino.text_embedding:evil-model:NPU:seq512:batch1:certified"] }],
    modelInventory: [{ name: "evil-model", device: "NPU", certificationTier: "certified" }],
  });
  const evaluation = placement.evaluateWorkerCandidate(
    placement.validatePlacementRequest(embeddingRequest()),
    forger, { executor: "openvino.text_embedding", model: "evil-model" }
  );
  assert.ok(evaluation.reasons.includes("model_not_certified"), "unlisted model must never be certified: " + JSON.stringify(evaluation));
  assert.notStrictEqual(evaluation.tier, "certified");
  workerManager.updateWorker(forger.workerId, { state: "offline", connectionState: "offline" });
});

test("worker-claimed tier can downgrade but never upgrade the manifest tier", () => {
  const modest = enrollTestWorker({ modelInventory: [{ name: QWEN, device: "NPU", certificationTier: "detected_self_tested" }] });
  const evaluation = placement.evaluateWorkerCandidate(
    placement.validatePlacementRequest(embeddingRequest()),
    modest, { executor: "openvino.text_embedding", model: QWEN }
  );
  assert.strictEqual(evaluation.tier, "detected_self_tested", "claimed downgrade honored");
  workerManager.updateWorker(modest.workerId, { state: "offline", connectionState: "offline" });
});

// ---- provider-path placement (chat/generation) ------------------------------

const mockProv = providerRegistry.createProvider({
  providerType: "mock", displayName: "mock-gen", endpoint: "http://mock",
  trustLevel: "trusted", priority: 60,
  dataClassifications: ["public", "internal", "private"],
});
const mockChatModel = modelRegistry.createModel({
  providerId: mockProv.providerId, providerModelName: "mock-medium",
  capabilities: ["chat", "generate"], supportsTools: true, supportsStructuredOutput: true, contextLimit: 8192,
});

test("healthy generation placement selects a registered provider/model", () => {
  const decision = placement.decidePlacement({ capability: "chat", data_classification: "private" });
  assert.ok(decision.selected, "chat candidate selected");
  assert.strictEqual(decision.selected.provider_id, mockProv.providerId);
  assert.strictEqual(decision.selected.execution_path, "provider");
});

test("tool/structured-output/context requirements filter models", () => {
  const limited = modelRegistry.createModel({
    providerId: mockProv.providerId, providerModelName: "mock-tiny",
    capabilities: ["chat"], supportsTools: false, supportsStructuredOutput: false, contextLimit: 1024,
  });
  for (const requirements of [{ tools: true }, { structured_output: true }, { context_limit: 4096 }]) {
    const decision = placement.decidePlacement({ capability: "chat", data_classification: "private", requirements });
    assert.ok(decision.selected, "a capable model exists");
    assert.strictEqual(decision.selected.model_id, mockChatModel.modelId, "capable model wins for " + JSON.stringify(requirements));
  }
  modelRegistry.deleteModel(limited.modelId);
});

test("private data is denied to a provider without the classification", () => {
  const publicOnly = providerRegistry.createProvider({
    providerType: "mock", displayName: "public-only", endpoint: "http://mock2",
    trustLevel: "trusted", priority: 99, dataClassifications: ["public"],
  });
  modelRegistry.createModel({ providerId: publicOnly.providerId, providerModelName: "mock-pub", capabilities: ["chat"] });
  const decision = placement.decidePlacement({ capability: "chat", data_classification: "private" });
  assert.notStrictEqual(decision.selected.provider_id, publicOnly.providerId, "classification-denied provider must not win on priority");
  assert.ok(decision.rejected.some(r => r.provider_id === publicOnly.providerId && r.reasons.includes("data_classification_denied")));
  providerRegistry.deleteProvider(publicOnly.providerId);
});

test("provider trust below the floor is rejected", () => {
  const untrusted = providerRegistry.createProvider({
    providerType: "mock", displayName: "untrusted", endpoint: "http://mock3",
    trustLevel: "untrusted", priority: 99, dataClassifications: ["public", "internal", "private"],
  });
  modelRegistry.createModel({ providerId: untrusted.providerId, providerModelName: "mock-u", capabilities: ["chat"] });
  const decision = placement.decidePlacement({ capability: "chat", data_classification: "private", trust_level_required: "trusted" });
  assert.notStrictEqual(decision.selected.provider_id, untrusted.providerId);
  assert.ok(decision.rejected.some(r => r.provider_id === untrusted.providerId && r.reasons.includes("trust_too_low")));
  providerRegistry.deleteProvider(untrusted.providerId);
});

test("circuit-open provider is excluded", () => {
  const flaky = providerRegistry.createProvider({
    providerType: "mock", displayName: "flaky", endpoint: "http://mock4",
    trustLevel: "trusted", priority: 99, dataClassifications: ["public", "internal", "private"],
  });
  modelRegistry.createModel({ providerId: flaky.providerId, providerModelName: "mock-f", capabilities: ["chat"] });
  for (let i = 0; i < 5; i++) providerRegistry.updateHealth(flaky.providerId, { status: "unreachable", error: "down", success: false });
  const decision = placement.decidePlacement({ capability: "chat", data_classification: "private" });
  assert.notStrictEqual(decision.selected.provider_id, flaky.providerId);
  assert.ok(decision.rejected.some(r => r.provider_id === flaky.providerId && r.reasons.includes("circuit_open")));
  providerRegistry.deleteProvider(flaky.providerId);
});

test("routing rules cannot re-admit a gate-failed candidate", () => {
  const denied = providerRegistry.createProvider({
    providerType: "mock", displayName: "rule-favored", endpoint: "http://mock5",
    trustLevel: "trusted", priority: 1, dataClassifications: ["public"],
  });
  modelRegistry.createModel({ providerId: denied.providerId, providerModelName: "mock-r", capabilities: ["chat"] });
  const db = dbStore.getDb();
  db.prepare(`INSERT INTO compute_routing_rules (rule_id, rule_name, priority, enabled, preferred_provider_ids_json) VALUES ('rule_test_1', 'favor-denied', 99, 1, ?)`)
    .run(JSON.stringify([denied.providerId]));
  const decision = placement.decidePlacement({ capability: "chat", data_classification: "private" });
  assert.notStrictEqual(decision.selected.provider_id, denied.providerId, "a rule preference must never bypass classification");
  db.prepare("DELETE FROM compute_routing_rules WHERE rule_id = 'rule_test_1'").run();
  providerRegistry.deleteProvider(denied.providerId);
});

test("malformed routing rule JSON does not break or bypass placement", () => {
  const db = dbStore.getDb();
  db.prepare(`INSERT INTO compute_routing_rules (rule_id, rule_name, priority, enabled, preferred_provider_ids_json) VALUES ('rule_test_bad', 'broken', 99, 1, 'not-json')`).run();
  const decision = placement.decidePlacement({ capability: "chat", data_classification: "private" });
  assert.ok(decision.selected, "placement still works with a malformed rule");
  db.prepare("DELETE FROM compute_routing_rules WHERE rule_id = 'rule_test_bad'").run();
});

// ---- explain mode ------------------------------------------------------------

test("explain and actual placement select the same candidate", () => {
  const request = embeddingRequest();
  const decision = placement.decidePlacement(request);
  const explained = placement.explainPlacement(request);
  assert.strictEqual(explained.dry_run, true);
  assert.deepStrictEqual(explained.selected, decision.selected, "dry run and real placement must agree");
  assert.strictEqual(explained.reason, decision.reason);
});

test("explain output leaks no endpoints, secrets, or raw config blobs", () => {
  const secretProv = providerRegistry.createProvider({
    providerType: "mock", displayName: "secretive", endpoint: "http://secret-host:9999",
    authSecretKey: "sk-super-secret", trustLevel: "trusted", priority: 1,
    dataClassifications: ["public"],
  });
  modelRegistry.createModel({ providerId: secretProv.providerId, providerModelName: "mock-s", capabilities: ["chat"] });
  const text = JSON.stringify(placement.explainPlacement({ capability: "chat", data_classification: "private" }));
  assert.ok(!text.includes("secret-host"), "endpoint must not appear in explain output");
  assert.ok(!text.includes("sk-super-secret"), "secret must not appear in explain output");
  assert.ok(!text.includes("health_json") && !text.includes("limits_json"), "raw config blobs must not appear");
  providerRegistry.deleteProvider(secretProv.providerId);
});

test("explain does not mutate provider circuit/health state", () => {
  const frozen = providerRegistry.createProvider({
    providerType: "mock", displayName: "frozen", endpoint: "http://mock6",
    trustLevel: "trusted", priority: 1, dataClassifications: ["public", "internal", "private"],
  });
  const db = dbStore.getDb();
  db.prepare("UPDATE compute_providers SET health_circuit_state = 'open', health_circuit_opened_at = ? WHERE provider_id = ?")
    .run(new Date(Date.now() - 3600000).toISOString(), frozen.providerId);
  placement.explainPlacement({ capability: "chat", data_classification: "private" });
  const after = providerRegistry.getProvider(frozen.providerId);
  assert.strictEqual(after.health.circuitState, "open", "explain must not transition circuit state");
  providerRegistry.deleteProvider(frozen.providerId);
});

// ---- distributed claim path: shared gates + per-executor concurrency --------

testAsync("private job is not claimable by a public-scoped worker", async () => {
  offlineAllWorkers();
  const scoped = enrollTestWorker({ allowedDataClassifications: ["public"] });
  const job = makeOpenvinoJob({ dataClassification: "private" });
  const claim = jobManager.claimNextJob(scoped, {});
  assert.strictEqual(claim, null, "claim must be refused");
  const diag = jobManager.getJob(job.jobId).schedulingDiagnostics;
  assert.ok(JSON.stringify(diag).includes("data_classification_denied"), "diagnostics record the denial");
  jobManager.cancelJob(job.jobId, { actor: "test" });
  workerManager.updateWorker(scoped.workerId, { state: "offline", connectionState: "offline" });
});

testAsync("per-executor concurrency prevents double-claiming the single-NPU executor", async () => {
  offlineAllWorkers();
  const worker = enrollTestWorker({ maxConcurrentJobs: 4 });
  const job1 = makeOpenvinoJob({});
  const job2 = makeOpenvinoJob({});
  const claim1 = jobManager.claimNextJob(worker, {});
  assert.ok(claim1 && claim1.job, "first claim succeeds");
  const claim2 = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.strictEqual(claim2, null, "second simultaneous OpenVINO claim must be refused despite worker-wide headroom");
  // Completing the first job frees the executor slot.
  jobManager.completeJob(claim1.job.jobId, worker.workerId, claim1.leaseId, {
    result: { embedding: [0.1], device: "NPU", requested_device: "NPU", fallback_occurred: false },
  });
  const claim3 = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.ok(claim3 && claim3.job, "claim succeeds after the executor slot frees");
  assert.strictEqual(claim3.job.jobId, job2.jobId);
  jobManager.completeJob(claim3.job.jobId, worker.workerId, claim3.leaseId, {
    result: { embedding: [0.1], device: "NPU", requested_device: "NPU", fallback_occurred: false },
  });
  workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
});

// ---- provenance -------------------------------------------------------------

testAsync("verified NPU provenance is persisted on the attempt", async () => {
  offlineAllWorkers();
  const worker = enrollTestWorker({});
  const job = makeOpenvinoJob({});
  const claim = jobManager.claimNextJob(worker, {});
  jobManager.completeJob(job.jobId, worker.workerId, claim.leaseId, {
    result: { embedding: [0.1, 0.2], device: "NPU", requested_device: "NPU", fallback_occurred: false },
  });
  const attempt = jobManager.listAttempts(job.jobId).find(a => a.leaseId === claim.leaseId);
  assert.strictEqual(attempt.accelerator, "NPU");
  assert.strictEqual(attempt.requestedAccelerator, "NPU");
  assert.strictEqual(attempt.acceleratorVerification, "manifest_confirmed");
  workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
});

testAsync("CPU fallback provenance and history are persisted", async () => {
  offlineAllWorkers();
  const worker = enrollTestWorker({});
  const job = makeOpenvinoJob({});
  const claim = jobManager.claimNextJob(worker, {});
  jobManager.completeJob(job.jobId, worker.workerId, claim.leaseId, {
    result: { embedding: [0.1], device: "CPU", requested_device: "NPU", fallback_occurred: true, fallback_reason: "npu_unavailable" },
  });
  const attempt = jobManager.listAttempts(job.jobId).find(a => a.leaseId === claim.leaseId);
  assert.strictEqual(attempt.accelerator, "CPU");
  assert.strictEqual(attempt.acceleratorVerification, "manifest_confirmed_fallback");
  const history = jobManager.getJob(job.jobId).fallbackHistory;
  assert.ok(history.some(h => h.fallback_occurred === true && h.accelerator === "CPU"), "fallback history entry recorded");
  workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
});

testAsync("a forged device claim is rejected, not recorded as actual", async () => {
  offlineAllWorkers();
  const worker = enrollTestWorker({});
  const job = makeOpenvinoJob({});
  const claim = jobManager.claimNextJob(worker, {});
  // Worker claims GPU — a device the manifest never permits for this model.
  jobManager.completeJob(job.jobId, worker.workerId, claim.leaseId, {
    result: { embedding: [0.1], device: "GPU", requested_device: "NPU", fallback_occurred: false },
  });
  const attempt = jobManager.listAttempts(job.jobId).find(a => a.leaseId === claim.leaseId);
  assert.strictEqual(attempt.accelerator, null, "forged device must not be recorded as actual");
  assert.strictEqual(attempt.acceleratorVerification, "rejected_claim");
  workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
});

testAsync("a requested accelerator alone is never recorded as actual", async () => {
  offlineAllWorkers();
  const worker = enrollTestWorker({});
  const job = makeOpenvinoJob({});
  const claim = jobManager.claimNextJob(worker, {});
  jobManager.completeJob(job.jobId, worker.workerId, claim.leaseId, {
    result: { embedding: [0.1], requested_device: "NPU" }, // no actual device reported
  });
  const attempt = jobManager.listAttempts(job.jobId).find(a => a.leaseId === claim.leaseId);
  assert.strictEqual(attempt.accelerator, null);
  assert.strictEqual(attempt.requestedAccelerator, "NPU");
  workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
});

testAsync("a stale attempt cannot finalize or write provenance over a newer attempt", async () => {
  offlineAllWorkers();
  const worker = enrollTestWorker({});
  const job = makeOpenvinoJob({});
  const claim1 = jobManager.claimNextJob(worker, {});
  // Expire the first lease and recover, then re-claim as attempt 2.
  const db = dbStore.getDb();
  db.prepare("UPDATE compute_jobs SET lease_expires_at = ? WHERE job_id = ?").run(new Date(Date.now() - 1000).toISOString(), job.jobId);
  jobManager.recoverExpiredLeases();
  db.prepare("UPDATE compute_jobs SET retry_after = ? WHERE job_id = ?").run(new Date(Date.now() - 1000).toISOString(), job.jobId);
  const claim2 = jobManager.claimNextJob(workerManager.getWorker(worker.workerId), {});
  assert.ok(claim2 && claim2.leaseId !== claim1.leaseId, "second attempt has a new lease");
  assert.throws(
    () => jobManager.completeJob(job.jobId, worker.workerId, claim1.leaseId, { result: { device: "NPU" } }),
    LeaseExpiredError,
    "stale lease must not finalize"
  );
  jobManager.completeJob(job.jobId, worker.workerId, claim2.leaseId, {
    result: { embedding: [0.1], device: "NPU", fallback_occurred: false },
  });
  const attempt2 = jobManager.listAttempts(job.jobId).find(a => a.leaseId === claim2.leaseId);
  assert.strictEqual(attempt2.acceleratorVerification, "manifest_confirmed", "winning attempt provenance intact");
  workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
});

testAsync("failed attempts append to the fallback history", async () => {
  offlineAllWorkers();
  const worker = enrollTestWorker({});
  const job = makeOpenvinoJob({});
  const claim = jobManager.claimNextJob(worker, {});
  jobManager.failJob(job.jobId, worker.workerId, claim.leaseId, { errorCategory: "helper_crash", errorMessage: "boom" });
  const history = jobManager.getJob(job.jobId).fallbackHistory;
  assert.ok(history.some(h => h.failed === true && h.error_category === "helper_crash"));
  jobManager.cancelJob(job.jobId, { actor: "test" });
  workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
});

// ---- direct inference path through the shared core ---------------------------

testAsync("chat executes against a placement-selected provider with honest provenance", async () => {
  const result = await inferenceService.chat({ messages: [{ role: "user", content: "hello" }] });
  assert.ok(result.content, "chat returns content");
  assert.strictEqual(result.providerId, mockProv.providerId);
  assert.strictEqual(result.acceleratorVerification, "not_verified", "provider execution never claims a verified device");
});

testAsync("classification without any eligible provider fails closed", async () => {
  // Only classification-limited providers exist for 'restricted'.
  await assert.rejects(
    () => inferenceService.chat({ messages: [{ role: "user", content: "x" }], dataClassification: "restricted" }),
    /No provider available/
  );
});

testAsync("embed gains policy-gated fallback across providers", async () => {
  const broken = providerRegistry.createProvider({
    providerType: "openai-compatible", displayName: "broken-embed", endpoint: "http://127.0.0.1:1",
    trustLevel: "trusted", priority: 99, dataClassifications: ["public", "internal", "private"],
  });
  modelRegistry.createModel({ providerId: broken.providerId, providerModelName: "broken-model", capabilities: ["embeddings"], supportsEmbedding: true });
  const good = modelRegistry.createModel({ providerId: mockProv.providerId, providerModelName: "mock-embed", capabilities: ["embeddings"], supportsEmbedding: true });
  const result = await inferenceService.embed({ input: "hello", preferences: { allowFallback: true } });
  assert.ok(Array.isArray(result.embedding) && result.embedding.length > 0, "embedding produced");
  assert.strictEqual(result.providerId, mockProv.providerId, "fell back to the healthy provider");
  assert.ok(result.fallback === true && result.fallbackHistory.length >= 1, "fallback recorded");
  providerRegistry.deleteProvider(broken.providerId);
  modelRegistry.deleteModel(good.modelId);
});

testAsync("fallback disabled stops after the first failure", async () => {
  const broken = providerRegistry.createProvider({
    providerType: "openai-compatible", displayName: "broken-only", endpoint: "http://127.0.0.1:1",
    trustLevel: "trusted", priority: 99, dataClassifications: ["public", "internal", "private"],
  });
  modelRegistry.createModel({ providerId: broken.providerId, providerModelName: "broken-2", capabilities: ["embeddings"], supportsEmbedding: true });
  const good = modelRegistry.createModel({ providerId: mockProv.providerId, providerModelName: "mock-embed2", capabilities: ["embeddings"], supportsEmbedding: true });
  await assert.rejects(
    () => inferenceService.embed({ input: "hello", preferences: { allowFallback: false } }),
    /All providers failed/
  );
  providerRegistry.deleteProvider(broken.providerId);
  modelRegistry.deleteModel(good.modelId);
});

// ---- summary ----------------------------------------------------------------

(async () => {
  for (const { name, fn } of asyncQueue) {
    try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
  }
  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
