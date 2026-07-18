"use strict";

// MCP-boundary contract test for the compute_jobs create path.
//
// Regression coverage for the defect where the MCP schema layer stripped
// undeclared fields (capability, request_payload, data_classification) and the
// job contract overwrote the requested capability with the canonical job type,
// making an openvino.text_embedding job unroutable. These tests drive the FULL
// MCP boundary via callMcpTool (dispatcher + Zod schema), not just the handler.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-compute-jobs-contract");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

// Set the environment the test needs, recording prior values so teardown can
// restore them deterministically (undefined => the variable was unset).
const TEST_ENV = {
  SIDEKICK_DATA_DIR: TEST_DATA_DIR,
  SIDEKICK_TOOL_POLICY: "open",
  SIDEKICK_APPROVAL_MODE: "off",
  SIDEKICK_SECRET_KEY: "compute-jobs-contract-test-secret",
  SIDEKICK_BLOCKED_TOOLS: undefined,
  SIDEKICK_APPROVAL_REQUIRED_TOOLS: undefined,
};
const ORIGINAL_ENV = {};
for (const [key, value] of Object.entries(TEST_ENV)) {
  ORIGINAL_ENV[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

delete require.cache[require.resolve("../src/tools")];
delete require.cache[require.resolve("../src/db")];

const { callMcpTool } = require("../src/tools");
const jobManager = require("../src/compute/job-manager");

// Deterministic teardown: close the SQLite handle, remove the generated data
// directory, and restore mutated environment variables. Runs on success AND
// failure so no generated test state is left behind.
function teardown() {
  try { require("../src/db").getDb().close(); } catch { /* already closed */ }
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.stack || e.message}`);
  }
}

const create = (args) => callMcpTool("sidekick_compute_jobs", { action: "create", ...args });
const getJob = (job_id) => callMcpTool("sidekick_compute_jobs", { action: "get", job_id });
const body = (res) => JSON.parse(res.content[0].text);

const OPENVINO_PAYLOAD = {
  executor: "openvino.text_embedding",
  model_id: "qwen3-embedding-0.6b-int8",
  input_kind: "query",
  text: "Sidekick end-to-end NPU validation",
  fallback: "none",
};

async function main() {
  console.log("Running compute_jobs MCP contract tests...\n");

  // Shared: create one OpenVINO job through the MCP boundary.
  let openvinoJob = null;

  await test("create: OpenVINO job survives the MCP boundary", async () => {
    const res = await create({
      job_type: "text_embedding",
      capability: "openvino.text_embedding",
      request_payload: { ...OPENVINO_PAYLOAD },
      data_classification: "internal",
      timeout_ms: 180000,
    });
    assert.ok(!res.isError, "create should succeed: " + res.content[0].text);
    const created = body(res);
    const readback = body(await getJob(created.jobId));
    openvinoJob = readback;
    assert.strictEqual(readback.capability, "openvino.text_embedding", "capability must be preserved exactly");
    assert.strictEqual(readback.jobType, "text_embedding", "jobType canonical");
  });

  await test("create: every nested request_payload field survives", async () => {
    const p = openvinoJob.requestPayload;
    assert.strictEqual(p.executor, "openvino.text_embedding");
    assert.strictEqual(p.model_id, "qwen3-embedding-0.6b-int8");
    assert.strictEqual(p.input_kind, "query");
    assert.strictEqual(p.text, "Sidekick end-to-end NPU validation");
    assert.strictEqual(p.fallback, "none", "fallback must remain none");
  });

  await test("create: request_payload is not polluted with top-level args", async () => {
    const p = openvinoJob.requestPayload;
    assert.strictEqual(p.job_type, undefined, "job_type must not leak into request_payload");
    assert.strictEqual(p.timeout_ms, undefined, "timeout_ms must not leak into request_payload");
    assert.strictEqual(p.capability, undefined, "capability must not leak into request_payload");
    assert.strictEqual(p.data_classification, undefined);
  });

  await test("create: supplied data_classification is preserved", async () => {
    assert.strictEqual(openvinoJob.dataClassification, "internal");
  });

  await test("create: data_classification defaults to private when omitted", async () => {
    const j = body(await create({ job_type: "embeddings", request_payload: { input: "hello" } }));
    assert.strictEqual(j.dataClassification, "private");
  });

  await test("routing: OpenVINO job is eligible for a worker advertising the executor type", async () => {
    const worker = {
      state: "online", maintenanceMode: false, protocolVersion: "1",
      currentJobs: 0, maxConcurrentJobs: 1, lastHeartbeat: new Date().toISOString(),
      executors: [{ type: "mock.inference" }, { type: "openvino.text_embedding", capabilities: ["embeddings"] }],
      providers: [{ type: "mock" }],
      modelInventory: [{ name: "qwen3-embedding-0.6b-int8" }],
    };
    const compat = jobManager.workerCompatibility(worker, openvinoJob);
    assert.strictEqual(compat.ok, true, "should be eligible: " + JSON.stringify(compat.reasons));
  });

  await test("routing: OpenVINO job is ineligible for a worker without the executor type", async () => {
    const worker = {
      state: "online", maintenanceMode: false, protocolVersion: "1",
      currentJobs: 0, maxConcurrentJobs: 1, lastHeartbeat: new Date().toISOString(),
      executors: [{ type: "mock.inference" }], providers: [{ type: "mock" }],
      modelInventory: [{ name: "deterministic-test" }],
    };
    const compat = jobManager.workerCompatibility(worker, openvinoJob);
    assert.strictEqual(compat.ok, false);
    assert.ok(compat.reasons.some((r) => r.includes("capability_missing")), "reason: " + JSON.stringify(compat.reasons));
  });

  await test("routing: workerCompatibility returns bestTier from model inventory", async () => {
    const worker = {
      state: "online", maintenanceMode: false, protocolVersion: "1",
      currentJobs: 0, maxConcurrentJobs: 2, lastHeartbeat: new Date().toISOString(),
      executors: [{ type: "mock.inference" }, { type: "openvino.text_embedding", capabilities: ["openvino.text_embedding:qwen3-embedding-0.6b-int8:CPU:seq512:batch1:certified"] }],
      providers: [{ type: "mock" }],
      modelInventory: [{ name: "qwen3-embedding-0.6b-int8", provider: "openvino", certificationTier: "certified" }],
    };
    const compat = jobManager.workerCompatibility(worker, openvinoJob);
    assert.strictEqual(compat.ok, true, "should be compatible: " + JSON.stringify(compat.reasons));
    assert.strictEqual(compat.bestTier, "certified", "should report certified tier");
  });

  await test("routing: workerCompatibility reports detected_self_tested tier", async () => {
    const worker = {
      state: "online", maintenanceMode: false, protocolVersion: "1",
      currentJobs: 0, maxConcurrentJobs: 2, lastHeartbeat: new Date().toISOString(),
      executors: [{ type: "mock.inference" }, { type: "openvino.text_embedding", capabilities: ["openvino.text_embedding:qwen3-embedding-0.6b-int8:CPU:seq512:batch1:detected_self_tested"] }],
      providers: [{ type: "mock" }],
      modelInventory: [{ name: "qwen3-embedding-0.6b-int8", provider: "openvino", certificationTier: "detected_self_tested" }],
    };
    const compat = jobManager.workerCompatibility(worker, openvinoJob);
    assert.strictEqual(compat.ok, true, "should be compatible: " + JSON.stringify(compat.reasons));
    assert.strictEqual(compat.bestTier, "detected_self_tested", "should report self-tested tier");
  });

  await test("security: unknown top-level field is rejected (not silently dropped)", async () => {
    const res = await create({
      job_type: "text_embedding",
      capability: "openvino.text_embedding",
      request_payload: { ...OPENVINO_PAYLOAD },
      bogus_unknown_field: "x",
    });
    assert.ok(res.isError, "unknown field must be rejected");
    assert.strictEqual(res.code, "validation_failed");
  });

  await test("security: malformed payload (missing model_id) is rejected", async () => {
    const p = { ...OPENVINO_PAYLOAD };
    delete p.model_id;
    const res = await create({ job_type: "text_embedding", capability: "openvino.text_embedding", request_payload: p });
    assert.ok(res.isError, "missing model_id must be rejected");
    assert.ok(/model_id/.test(res.content[0].text), res.content[0].text);
  });

  await test("security: forbidden process field in payload is rejected", async () => {
    const res = await create({
      job_type: "text_embedding", capability: "openvino.text_embedding",
      request_payload: { ...OPENVINO_PAYLOAD, device: "CPU" },
    });
    assert.ok(res.isError, "forbidden 'device' field must be rejected");
  });

  await test("security: conflicting executor identity is rejected", async () => {
    const res = await create({
      job_type: "text_embedding", capability: "openvino.text_embedding",
      request_payload: { ...OPENVINO_PAYLOAD, executor: "mock.inference" },
    });
    assert.ok(res.isError, "conflicting executor must be rejected");
  });

  await test("security: request_payload combined with convenience fields is rejected", async () => {
    const res = await create({
      job_type: "generate", request_payload: { prompt: "a" }, prompt: "b",
    });
    assert.ok(res.isError, "prompt + request_payload conflict must be rejected");
  });

  await test("security: non-object request_payload is rejected", async () => {
    const res = await create({ job_type: "text_embedding", request_payload: "not-an-object" });
    assert.ok(res.isError, "non-object request_payload must be rejected");
  });

  await test("legacy: generate job still works via convenience fields", async () => {
    const res = await create({ job_type: "generate", model: "deterministic-test", prompt: "hello world" });
    assert.ok(!res.isError, "legacy create should succeed: " + res.content[0].text);
    const j = body(res);
    assert.strictEqual(j.jobType, "generate");
    assert.strictEqual(j.capability, "generate", "capability defaults to canonical job type when unspecified");
    assert.strictEqual(j.requestPayload.prompt, "hello world");
    assert.strictEqual(j.requestPayload.model, "deterministic-test");
    assert.strictEqual(j.requestPayload.job_type, undefined, "no arg pollution");
  });

  await test("legacy: job_type 'embedding' canonicalizes to 'embeddings'", async () => {
    const j = body(await create({ job_type: "embedding", request_payload: { input: "x" } }));
    assert.strictEqual(j.jobType, "embeddings");
  });

  await test("create: job_type is required", async () => {
    const res = await create({ capability: "openvino.text_embedding", request_payload: { ...OPENVINO_PAYLOAD } });
    assert.ok(res.isError, "missing job_type must be rejected");
    assert.ok(/job_type/.test(res.content[0].text));
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
}

(async () => {
  try {
    await main();
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    teardown();
    process.exitCode = failed > 0 ? 1 : 0;
  }
})();
