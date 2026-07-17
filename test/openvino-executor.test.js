"use strict";

const path = require("path");
const assert = require("assert");

const { initOpenVinoExecutor, executeOpenVinoEmbed, getCapabilityStatus, getOpenVinoCapabilities } = require("../src/compute/openvino-executor");
const { loadOpenVinoConfig, validateConfigPath, validatePythonPath } = require("../src/compute/openvino-config");
const { validateJobRequest, getApprovedModel } = require("../src/compute/openvino-model-manifest");
const { HelperManager, HelperProcess } = require("../src/compute/openvino-helper-manager");

// ---------------------------------------------------------------------------
// Test Utilities
// ---------------------------------------------------------------------------

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

function assertRejects(fn, matchStr) {
  return async () => {
    let err;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    if (!err) throw new Error("Expected function to reject/throw");
    if (matchStr && !err.message.includes(matchStr)) {
      throw new Error(`Expected error message to include '${matchStr}', got: '${err.message}'`);
    }
  };
}

// ---------------------------------------------------------------------------
// Mock Configuration
// ---------------------------------------------------------------------------

const MOCK_CONFIG = {
  enabled: true,
  pythonPath: path.join(__dirname, "helpers", "mock-python.sh"), // Use shell wrapper to ignore -u
  modelsDir: path.join(__dirname, "mock-models"),
  cacheDir: path.join(__dirname, "mock-cache"),
  stateDir: path.join(__dirname, "mock-state"),
  helperScript: path.join(__dirname, "helpers", "mock-openvino-helper.js"),
  startupTimeoutMs: 5000,
  inferenceTimeoutMs: 2000,
  maxInputChars: 32768,
  maxOutputDimensions: 1024,
  maxConcurrentInferences: 1,
  maxHelperRestarts: 2,
  helperRestartCooldownMs: 100,
  fallbackPolicy: "same_model_cpu",
  logLevel: "error",
  diagnosticMode: false,
  protocolVersion: "1",
  helperVersion: "1.0.0"
};

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

async function runConfigTests() {
  console.log("\nConfig Validation Tests:");

  await test("Rejects UNC paths", () => {
    assert.throws(() => validateConfigPath("\\\\server\\share\\models", "TEST"), /UNC\/network paths are not allowed/);
  });

  await test("Rejects URL paths", () => {
    assert.throws(() => validateConfigPath("https://models.com", "TEST"), /URL paths are not allowed/);
  });

  await test("Rejects null bytes", () => {
    assert.throws(() => validateConfigPath("C:\\models\0", "TEST"), /null byte/);
  });

  await test("Rejects traversal", () => {
    assert.throws(() => validateConfigPath("C:\\models\\..\\windows", "TEST"), /traversal components/);
  });

  await test("Python path requires absolute path", () => {
    assert.throws(() => validatePythonPath("python"), /not an absolute path/);
  });
}

async function runManifestTests() {
  console.log("\nModel Manifest Tests:");

  await test("Validates valid job payload", () => {
    const job = {
      model_id: "qwen3-embedding-0.6b-int8",
      input_kind: "query",
      text: "hello world"
    };
    const err = validateJobRequest(job, MOCK_CONFIG);
    assert.strictEqual(err, null);
  });

  await test("Rejects unauthorized fields (command injection proxy)", () => {
    const job = {
      model_id: "e5-small-v2-qint8",
      input_kind: "query",
      text: "hello world",
      shell: true // unauthorized
    };
    const err = validateJobRequest(job, MOCK_CONFIG);
    assert.ok(err.includes("forbidden field 'shell'"));
  });

  await test("Rejects unknown models", () => {
    const job = {
      model_id: "hacker-model",
      input_kind: "query",
      text: "test"
    };
    const err = validateJobRequest(job, MOCK_CONFIG);
    assert.ok(err.includes("not in the approved model catalogue"));
  });

  await test("Rejects missing text", () => {
    const job = { model_id: "e5-small-v2-qint8", input_kind: "query" };
    const err = validateJobRequest(job, MOCK_CONFIG);
    assert.ok(err.includes("missing required string field 'text'"));
  });

  await test("CLAP audio NPU permanently denied", () => {
    const model = getApprovedModel("e5-small-v2-qint8");
    // Simulate someone trying to bypass
    const job = { model_id: "clap", input_kind: "query", text: "test" };
    const err = validateJobRequest(job, MOCK_CONFIG);
    assert.ok(err.includes("not in the approved model catalogue"));
  });
}

async function runExecutorTests() {
  console.log("\nExecutor Integration Tests:");

  // Initialize executor with our Node-based mock helper.
  const initResult = await initOpenVinoExecutor(MOCK_CONFIG);

  await test("Executor initializes with mock config", () => {
    assert.strictEqual(initResult.enabled, true);
    assert.strictEqual(initResult.error, null);
  });

  // Give the helper a moment to emit 'started' (which happens immediately in mock).
  await new Promise(r => setTimeout(r, 500));

  await test("Capability status detects mock devices", () => {
    const status = getCapabilityStatus();
    assert.strictEqual(status.status, "ready");
    assert.ok(status.availableDevices.includes("NPU"));
    assert.ok(status.capabilities.length > 0);
  });

  await test("Executes basic E5 embedding (CPU)", async () => {
    const job = {
      model_id: "e5-small-v2-qint8",
      input_kind: "document",
      text: "Testing basic execution"
    };
    const res = await executeOpenVinoEmbed(null, job);
    assert.strictEqual(res.device, "CPU");
    assert.strictEqual(res.dimensions, 384);
    assert.strictEqual(res.model_id, "e5-small-v2-qint8");
    assert.strictEqual(res.normalized, true);
    assert.ok(Array.isArray(res.embedding));
    assert.strictEqual(res.embedding.length, 384);
  });

  await test("Executes Qwen embedding (NPU)", async () => {
    const job = {
      model_id: "qwen3-embedding-0.6b-int8",
      input_kind: "query",
      text: "Testing NPU"
    };
    const res = await executeOpenVinoEmbed(null, job);
    assert.strictEqual(res.device, "NPU");
    assert.strictEqual(res.dimensions, 1024);
    assert.strictEqual(res.requested_device, "NPU");
  });

  await test("Qwen with fallback policy triggers same_model_cpu", async () => {
    const job = {
      model_id: "qwen3-embedding-0.6b-int8",
      input_kind: "query",
      text: "Testing NPU fallback",
      fallback: "same_model_cpu"
    };
    const res = await executeOpenVinoEmbed(null, job);
    assert.strictEqual(res.device, "CPU"); // Our mock returns CPU when fallback requested for qwen
    assert.strictEqual(res.fallback_occurred, true);
  });

  await test("Rejects un-normalized (bad norm) output", async () => {
    const job = {
      model_id: "e5-small-v2-qint8",
      input_kind: "document",
      text: "bad-norm"
    };
    await assertRejects(
      () => executeOpenVinoEmbed(null, job),
      "Embedding L2 norm"
    )();
  });

  await test("Rejects non-finite output", async () => {
    const job = {
      model_id: "e5-small-v2-qint8",
      input_kind: "document",
      text: "non-finite"
    };
    await assertRejects(
      () => executeOpenVinoEmbed(null, job),
      "non-finite values"
    )();
  });

  await test("Handles helper crash properly", async () => {
    const job = {
      model_id: "e5-small-v2-qint8",
      input_kind: "document",
      text: "crash"
    };
    await assertRejects(
      () => executeOpenVinoEmbed(null, job),
      "Helper exited unexpectedly"
    )();
  });

  // Wait for cooldown to allow restart
  await new Promise(r => setTimeout(r, 200));

  await test("Helper restarts successfully after crash", async () => {
    const job = {
      model_id: "e5-small-v2-qint8",
      input_kind: "document",
      text: "recovery test"
    };
    const res = await executeOpenVinoEmbed(null, job);
    assert.strictEqual(res.device, "CPU");
  });

  await test("Handles inference timeout (hang)", async () => {
    const job = {
      model_id: "e5-small-v2-qint8",
      input_kind: "document",
      text: "hang" // Our mock will sleep forever
    };

    // The executor is configured with inferenceTimeoutMs: 2000 in MOCK_CONFIG
    await assertRejects(
      () => executeOpenVinoEmbed(null, job),
      "timed out"
    )();
  });

  // Shut down the manager to clean up the hanging mock process
  const { shutdownOpenVinoExecutor } = require("../src/compute/openvino-executor");
  shutdownOpenVinoExecutor();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Starting OpenVINO Executor Tests...");
  await runConfigTests();
  await runManifestTests();
  await runExecutorTests();

  console.log("\nSummary:");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
