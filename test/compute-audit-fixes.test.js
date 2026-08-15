"use strict";

// Production-completion audit regressions that live outside the
// runner/cancellation suites:
//
//  - compute_route action=explain used to DROP its arguments (snake_case tool
//    surface vs camelCase explain API) and always evaluate a default
//    chat/private request.
//  - requested_device is deliberately caller-suppliable and is now named in an
//    explicit allowlist at the job-creation choke point, while raw device /
//    accelerator pinning stays rejected.
//  - the async llm job's model fallback used OLLAMA_MODEL || hardcoded default
//    while provider bootstrap used OLLAMA_MODEL || SIDEKICK_AGENT_MODEL ||
//    default — with only SIDEKICK_AGENT_MODEL set, async jobs demanded a model
//    no bootstrapped provider or worker advertised.
//  - placement is device-aware: a job pinning requested_device is not placed
//    on a worker whose per-device capability strings never probed that device.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-compute-audit-fixes");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";

delete require.cache[require.resolve("../src/db")];
require("../src/db");
const compute = require("../src/compute");
const providerRegistry = require("../src/compute/provider-registry");
const modelRegistry = require("../src/compute/model-registry");
const jobManager = require("../src/compute/job-manager");
const workerManager = require("../src/compute/worker-manager");
const placement = require("../src/compute/placement");
const computeTools = require("../src/compute/tools");

compute.initialize();
compute.stopReconciliation();

const QWEN = "qwen3-embedding-0.6b-int8";

console.log("Running Compute Audit Fix tests...\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack || e.message}`); }
}

(async () => {
  console.log("AF.1: compute_route explain arguments actually reach the decision");

  // A provider certified for PUBLIC data only: whether explain selects it must
  // depend on the data_classification argument the caller supplied.
  const publicProvider = providerRegistry.createProvider({
    displayName: "public-only", providerType: "mock", endpoint: "http://mock",
    trustLevel: "trusted", dataClassifications: ["public"], priority: 90,
  });
  modelRegistry.createModel({
    providerId: publicProvider.providerId, providerModelName: "public-model",
    displayName: "public-model", capabilities: ["chat", "generate"],
  });

  await test("data_classification argument changes the selected provider", async () => {
    const asPublic = JSON.parse((await computeTools.sidekick_compute_route({
      action: "explain", workload_class: "chat", data_classification: "public",
    })).content[0].text);
    assert.ok(asPublic.selected, "public request selects the public-only provider");
    assert.strictEqual(asPublic.selected.providerId, publicProvider.providerId);

    const asPrivate = JSON.parse((await computeTools.sidekick_compute_route({
      action: "explain", workload_class: "chat", data_classification: "private",
    })).content[0].text);
    // Before the mapping fix both calls evaluated the identical default
    // request; the classification gate must now reject the public-only row.
    assert.strictEqual(asPrivate.selected, null, "private request refuses the public-only provider");
  });

  await test("workload/capability and trust arguments reach the placement dry run", async () => {
    const r = JSON.parse((await computeTools.sidekick_compute_route({
      action: "explain", workload_class: "embeddings", data_classification: "public", trust_level: "privileged",
    })).content[0].text);
    assert.strictEqual(r.placement.capability, "embeddings", "capability no longer forced to default chat");
    assert.strictEqual(r.placement.policy.data_classification, "public");
    assert.strictEqual(r.placement.policy.trust_level_required, "privileged");
    assert.strictEqual(r.selected, null, "trusted-only provider fails a privileged-trust request");
  });

  await test("capabilities_required wins over workload_class for the capability", async () => {
    const r = JSON.parse((await computeTools.sidekick_compute_route({
      action: "explain", workload_class: "background", capabilities_required: "generate", data_classification: "public",
    })).content[0].text);
    assert.strictEqual(r.placement.capability, "generate");
  });

  console.log("\nAF.2: requested_device allowlist at the job-creation choke point");

  await test("requested_device is accepted in a job payload", async () => {
    const job = jobManager.createJob({
      jobType: "chat", capability: "chat", source: "test",
      dataClassification: "private",
      requestPayload: { prompt: "x", requested_device: "NPU" },
    });
    assert.strictEqual(job.requestPayload.requested_device, "NPU");
    jobManager.cancelJob(job.jobId, { reason: "cleanup" });
  });

  await test("raw device / accelerator pinning stays rejected", async () => {
    for (const field of ["device", "accelerator", "requested_accelerator", "worker_id"]) {
      assert.throws(
        () => jobManager.createJob({
          jobType: "chat", capability: "chat", source: "test",
          dataClassification: "private",
          requestPayload: { prompt: "x", [field]: "NPU" },
        }),
        /not permitted/,
        `${field} must remain forbidden`
      );
    }
  });

  console.log("\nAF.3: async llm model fallback chain matches provider bootstrap");

  await test("with only SIDEKICK_AGENT_MODEL set, the async job uses it", async () => {
    const prevOllama = process.env.OLLAMA_MODEL;
    const prevAgent = process.env.SIDEKICK_AGENT_MODEL;
    delete process.env.OLLAMA_MODEL;
    process.env.SIDEKICK_AGENT_MODEL = "agent-model:test";
    try {
      const { sidekick_llm } = require("../src/tools/families/inference");
      const response = await sidekick_llm({ prompt: "async model chain", async: true });
      const body = JSON.parse(response.content[0].text);
      const job = jobManager.getJob(body.job_id);
      assert.strictEqual(job.requestPayload.model, "agent-model:test",
        "payload model follows OLLAMA_MODEL || SIDEKICK_AGENT_MODEL || default");
      assert.strictEqual(job.capabilityRequirements.model, "agent-model:test",
        "capability requirement agrees, so placement demands a model something advertises");
      jobManager.cancelJob(job.jobId, { reason: "cleanup" });
    } finally {
      if (prevOllama === undefined) delete process.env.OLLAMA_MODEL; else process.env.OLLAMA_MODEL = prevOllama;
      if (prevAgent === undefined) delete process.env.SIDEKICK_AGENT_MODEL; else process.env.SIDEKICK_AGENT_MODEL = prevAgent;
    }
  });

  console.log("\nAF.4: device-aware placement for requested_device");

  function enrollOpenVinoWorker(devices) {
    const token = workerManager.createEnrollmentToken({ displayName: "device-aware", trustLevel: "trusted", maxConcurrentJobs: 1 });
    const enrolled = workerManager.enrollWorker({
      nodeId: "device-node-" + Math.random().toString(36).slice(2, 8),
      displayName: "device-aware", platform: "win32", enrollmentToken: token.token,
      executors: [{
        type: "openvino.text_embedding",
        capabilities: devices.map(d => `openvino.text_embedding:${QWEN}:${d}:seq512:batch1:certified`),
      }],
      modelInventory: [{ name: QWEN, device: devices[0], certificationTier: "certified" }],
    });
    workerManager.updateWorker(enrolled.workerId, { state: "online", connectionState: "online" });
    return workerManager.getWorker(enrolled.workerId);
  }

  function embedJob(requestedDevice) {
    return jobManager.createJob({
      jobType: "text_embedding", capability: "openvino.text_embedding", source: "test",
      dataClassification: "private",
      capabilityRequirements: { executor: "openvino.text_embedding" },
      requestPayload: { input: "x", model: QWEN, ...(requestedDevice ? { requested_device: requestedDevice } : {}) },
    });
  }

  await test("a GPU-only worker is rejected for an explicit-NPU job and accepted for GPU", async () => {
    const worker = enrollOpenVinoWorker(["GPU"]);
    const npuJob = embedJob("NPU");
    const npuCompat = jobManager.workerCompatibility(worker, npuJob);
    assert.strictEqual(npuCompat.ok, false);
    assert.ok(npuCompat.reasons.includes("requested_device_unavailable"), `reasons: ${npuCompat.reasons}`);

    const gpuJob = embedJob("GPU");
    const gpuCompat = jobManager.workerCompatibility(worker, gpuJob);
    assert.strictEqual(gpuCompat.ok, true, `reasons: ${gpuCompat.reasons}`);

    // The claim path uses the same predicate: the NPU job must not be leased.
    const claim = jobManager.claimNextJob(worker, {});
    assert.ok(claim, "some job claimed");
    assert.strictEqual(claim.job.jobId, gpuJob.jobId, "the claim skipped the NPU-pinned job");
    jobManager.cancelJob(npuJob.jobId, { reason: "cleanup" });
    jobManager.cancelJob(gpuJob.jobId, { reason: "cleanup" });
    workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
  });

  await test("a worker without per-model capability strings keeps legacy behaviour", async () => {
    // Bare executor declarations (legacy workers, minimal fixtures) advertise
    // no per-device strings; absence of data must not become a rejection.
    const token = workerManager.createEnrollmentToken({ displayName: "bare", trustLevel: "trusted", maxConcurrentJobs: 1 });
    const enrolled = workerManager.enrollWorker({
      nodeId: "bare-node-" + Math.random().toString(36).slice(2, 8),
      displayName: "bare", platform: "win32", enrollmentToken: token.token,
      executors: [{ type: "openvino.text_embedding" }],
      modelInventory: [{ name: QWEN, device: "NPU", certificationTier: "certified" }],
    });
    workerManager.updateWorker(enrolled.workerId, { state: "online", connectionState: "online" });
    const worker = workerManager.getWorker(enrolled.workerId);
    const job = embedJob("NPU");
    const compat = jobManager.workerCompatibility(worker, job);
    assert.ok(!compat.reasons.includes("requested_device_unavailable"),
      "no device rejection without advertised device data");
    jobManager.cancelJob(job.jobId, { reason: "cleanup" });
    workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
  });

  await test("evaluateWorkerCandidate exposes the stable rejection reason", async () => {
    const worker = enrollOpenVinoWorker(["NPU"]);
    const evaluation = placement.evaluateWorkerCandidate(
      { capability: "openvino.text_embedding", dataClassification: "private", trustLevelRequired: "trusted", requirements: {} },
      worker,
      { executor: "openvino.text_embedding", model: QWEN, requestedDevice: "GPU" }
    );
    assert.strictEqual(evaluation.ok, false);
    assert.ok(evaluation.reasons.includes("requested_device_unavailable"));
    workerManager.updateWorker(worker.workerId, { state: "offline", connectionState: "offline" });
  });

  console.log(`\nCompute Audit Fix tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error("Fatal:", e); process.exit(1); });
