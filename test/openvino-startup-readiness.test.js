"use strict";

/**
 * OpenVINO startup capability readiness tests.
 *
 * Two layers:
 *   A. Worker advertisement shaping — that executors / modelInventory / health
 *      are built from the executor's readiness snapshot and agree with each
 *      other, without spawning a real helper (uses the worker-agent test seam).
 *   B. The real bounded readiness path in openvino-executor, driven by the Node
 *      mock helper, across: NPU present, NPU absent (CPU-only), helper failure,
 *      readiness timeout, disabled, and shutdown-during-initialisation.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Layer A — worker advertisement shaping (no real helper)
// ---------------------------------------------------------------------------

const workerAgent = require("../src/compute/worker-agent");

const READY_SNAPSHOT = {
  state: "ready",
  reason: "2 model(s) ready",
  availableDevices: ["CPU", "GPU", "NPU"],
  capabilities: [
    "openvino.text_embedding:e5-small-v2-qint8:CPU:seq512:batch1:certified",
    "openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq128:batch1:certified",
    "openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq512:batch1:certified",
  ],
  models: [
    { name: "e5-small-v2-qint8", provider: "openvino", device: "CPU", dimensions: 384, embeddingSpaceId: "e5-small-v2", capabilities: ["openvino.text_embedding:e5-small-v2-qint8:CPU:seq512:batch1:certified"], certificationTier: "certified" },
    { name: "qwen3-embedding-0.6b-int8", provider: "openvino", device: "NPU", dimensions: 1024, embeddingSpaceId: "qwen3-embedding-0.6b", capabilities: ["openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq128:batch1:certified", "openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq512:batch1:certified"], certificationTier: "certified" },
  ],
  openVinoVersion: "2026.2.1-test",
  helperVersion: "1.0.0",
};

const CPU_ONLY_SNAPSHOT = {
  state: "ready",
  reason: "1 model ready on [CPU]",
  availableDevices: ["CPU"],
  capabilities: ["openvino.text_embedding:e5-small-v2-qint8:CPU:seq512:batch1:certified"],
  models: [
    { name: "e5-small-v2-qint8", provider: "openvino", device: "CPU", dimensions: 384, embeddingSpaceId: "e5-small-v2", capabilities: ["openvino.text_embedding:e5-small-v2-qint8:CPU:seq512:batch1:certified"], certificationTier: "certified" },
  ],
  openVinoVersion: "2026.2.1-test",
  helperVersion: "1.0.0",
};

function fakeExecutor(snapshot) {
  return {
    EXECUTOR_TYPE: "openvino.text_embedding",
    EXECUTOR_VERSION: "1",
    getStartupReadiness: () => snapshot,
  };
}

function ovExecutorEntry(sysInfo) {
  return sysInfo.executors.find(e => e.type === "openvino.text_embedding");
}
function ovModelEntries(sysInfo) {
  return sysInfo.modelInventory.filter(m => m.provider === "openvino");
}

async function runShapingTests() {
  console.log("\nWorker advertisement shaping:");

  await test("disabled: no OpenVINO executor, model, or health block", () => {
    delete process.env.SIDEKICK_OPENVINO_ENABLED;
    workerAgent.__setOpenVinoExecutorForTest(null);
    const info = workerAgent.collectSystemInfo();
    assert.strictEqual(ovExecutorEntry(info), undefined, "no openvino executor");
    assert.strictEqual(ovModelEntries(info).length, 0, "no openvino models");
    assert.strictEqual(info.health.openvino, undefined, "no openvino health block");
  });

  await test("enabled + probing: not advertised, no placeholder caps, honest health", () => {
    process.env.SIDEKICK_OPENVINO_ENABLED = "true";
    workerAgent.__setOpenVinoExecutorForTest(fakeExecutor({ state: "probing", reason: "starting", capabilities: [], models: [], availableDevices: [] }));
    const info = workerAgent.collectSystemInfo();
    assert.strictEqual(ovExecutorEntry(info), undefined, "openvino not advertised while probing");
    assert.strictEqual(ovModelEntries(info).length, 0, "no openvino models while probing");
    assert.strictEqual(info.health.openvino.state, "probing");
    // Critically, the old generic placeholder ["embeddings"] must NOT appear.
    assert.ok(!info.executors.some(e => e.type === "openvino.text_embedding"), "no placeholder openvino executor");
  });

  await test("enabled + unavailable: not advertised, health reports unavailable", () => {
    process.env.SIDEKICK_OPENVINO_ENABLED = "true";
    workerAgent.__setOpenVinoExecutorForTest(fakeExecutor({ state: "unavailable", reason: "no profile ready", capabilities: [], models: [], availableDevices: ["CPU"] }));
    const info = workerAgent.collectSystemInfo();
    assert.strictEqual(ovExecutorEntry(info), undefined);
    assert.strictEqual(info.health.openvino.state, "unavailable");
  });

  await test("enabled + ready: concrete caps advertised; inventory agrees with capabilities", () => {
    process.env.SIDEKICK_OPENVINO_ENABLED = "true";
    workerAgent.__setOpenVinoExecutorForTest(fakeExecutor(READY_SNAPSHOT));
    const info = workerAgent.collectSystemInfo();
    const exec = ovExecutorEntry(info);
    assert.ok(exec, "openvino executor advertised");
    assert.deepStrictEqual(exec.capabilities, READY_SNAPSHOT.capabilities);
    assert.strictEqual(exec.state, "ready");

    const invNames = ovModelEntries(info).map(m => m.name).sort();
    assert.deepStrictEqual(invNames, ["e5-small-v2-qint8", "qwen3-embedding-0.6b-int8"]);

    // Agreement: every advertised model appears in >=1 capability string, and
    // every capability string's model appears in the inventory.
    for (const name of invNames) {
      assert.ok(exec.capabilities.some(c => c.includes(name)), `capability exists for ${name}`);
    }
    for (const cap of exec.capabilities) {
      const modelSeg = cap.split(":")[1];
      assert.ok(invNames.includes(modelSeg), `inventory has model ${modelSeg} for capability ${cap}`);
    }
    assert.strictEqual(info.health.openvino.state, "ready");
  });

  await test("first heartbeat carries the readiness advertisement (no job needed)", () => {
    process.env.SIDEKICK_OPENVINO_ENABLED = "true";
    workerAgent.__setOpenVinoExecutorForTest(fakeExecutor(READY_SNAPSHOT));
    // collectSystemInfo() is exactly what the first heartbeat/enrollment sends.
    const info = workerAgent.collectSystemInfo();
    const exec = ovExecutorEntry(info);
    assert.ok(exec && exec.capabilities.length === 3, "first advertisement already has concrete caps");
    assert.ok(exec.capabilities.some(c => c.includes(":NPU:")), "NPU profile present in first advertisement");
  });

  await test("CPU-only readiness: E5 advertised, no NPU capability claimed", () => {
    process.env.SIDEKICK_OPENVINO_ENABLED = "true";
    workerAgent.__setOpenVinoExecutorForTest(fakeExecutor(CPU_ONLY_SNAPSHOT));
    const info = workerAgent.collectSystemInfo();
    const exec = ovExecutorEntry(info);
    assert.ok(exec, "openvino advertised on CPU-only host");
    assert.ok(exec.capabilities.every(c => !c.includes(":NPU:")), "no NPU capability advertised");
    assert.ok(exec.capabilities.some(c => c.includes(":CPU:")), "CPU capability advertised");
    const invNames = ovModelEntries(info).map(m => m.name);
    assert.deepStrictEqual(invNames, ["e5-small-v2-qint8"], "only CPU-certified model in inventory");
  });

  await test("capabilities carry certification tier suffix in executor and inventory", () => {
    process.env.SIDEKICK_OPENVINO_ENABLED = "true";
    workerAgent.__setOpenVinoExecutorForTest(fakeExecutor(READY_SNAPSHOT));
    const info = workerAgent.collectSystemInfo();
    const exec = ovExecutorEntry(info);
    assert.ok(exec, "openvino executor present");
    for (const cap of exec.capabilities) {
      assert.ok(cap.endsWith(":certified"), `capability '${cap}' ends with :certified`);
    }
    const ovModels = ovModelEntries(info);
    for (const m of ovModels) {
      assert.strictEqual(m.certificationTier, "certified", `model ${m.name} has certificationTier`);
    }
    const healthModels = info.health.openvino.models || [];
    for (const hm of healthModels) {
      assert.strictEqual(hm.certificationTier, "certified", `health model ${hm.name} has certificationTier`);
    }
  });

  // Reset shaping state.
  delete process.env.SIDEKICK_OPENVINO_ENABLED;
  workerAgent.__setOpenVinoExecutorForTest(null);
}

// ---------------------------------------------------------------------------
// Layer B — real bounded readiness path with the mock helper
// ---------------------------------------------------------------------------

const ovExecutor = require("../src/compute/openvino-executor");

function makeConfig(modelsDir, overrides = {}) {
  return {
    enabled: true,
    pythonPath: path.join(__dirname, "helpers", "mock-python.sh"),
    modelsDir,
    cacheDir: path.join(modelsDir, "cache"),
    stateDir: path.join(modelsDir, "state"),
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
    helperVersion: "1.0.0",
    ...overrides,
  };
}

function scenarioDir(control) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ov-readiness-"));
  if (control) fs.writeFileSync(path.join(dir, "mock-control.json"), JSON.stringify(control));
  return dir;
}

async function runReadinessTests() {
  console.log("\nBounded readiness path (mock helper):");

  await test("disabled config yields state 'disabled' with no work", async () => {
    await ovExecutor.initOpenVinoExecutor({ enabled: false });
    const r = await ovExecutor.awaitStartupReadiness(2000);
    assert.strictEqual(r.state, "disabled");
    assert.strictEqual(r.capabilities.length, 0);
    ovExecutor.shutdownOpenVinoExecutor();
  });

  await test("NPU present: ready with E5 CPU + Qwen NPU profiles (no Qwen CPU)", async () => {
    const dir = scenarioDir({ devices: ["CPU", "GPU", "NPU"] });
    await ovExecutor.initOpenVinoExecutor(makeConfig(dir));
    const r = await ovExecutor.awaitStartupReadiness(8000);
    assert.strictEqual(r.state, "ready", `state was ${r.state}: ${r.reason}`);
    assert.ok(r.availableDevices.includes("NPU"));
    assert.ok(r.capabilities.includes("openvino.text_embedding:e5-small-v2-qint8:CPU:seq512:batch1:certified"), "E5 CPU");
    assert.ok(r.capabilities.includes("openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq128:batch1:certified"), "Qwen NPU 128");
    assert.ok(r.capabilities.includes("openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq512:batch1:certified"), "Qwen NPU 512");
    // Qwen CPU must NOT be advertised: it is only a job-time fallback, never
    // derived from the NPU model's certification.
    assert.ok(!r.capabilities.some(c => c.includes("qwen") && c.includes(":CPU:")), "no Qwen CPU capability");
    const names = r.models.map(m => m.name).sort();
    assert.deepStrictEqual(names, ["e5-small-v2-qint8", "qwen3-embedding-0.6b-int8"]);
    // Verify certificationTier on all models.
    for (const m of r.models) {
      assert.strictEqual(m.certificationTier, "certified", `model ${m.name} certificationTier`);
    }
    ovExecutor.shutdownOpenVinoExecutor();
    await sleep(150);
  });

  await test("NPU absent: CPU profile still ready; no NPU capability, no Qwen", async () => {
    const dir = scenarioDir({ devices: ["CPU"] });
    await ovExecutor.initOpenVinoExecutor(makeConfig(dir));
    const r = await ovExecutor.awaitStartupReadiness(8000);
    assert.strictEqual(r.state, "ready", `state was ${r.state}: ${r.reason}`);
    assert.deepStrictEqual(r.availableDevices, ["CPU"]);
    assert.deepStrictEqual(r.capabilities, ["openvino.text_embedding:e5-small-v2-qint8:CPU:seq512:batch1:certified"]);
    assert.ok(!r.capabilities.some(c => c.includes(":NPU:")), "no NPU capability when NPU absent");
    assert.deepStrictEqual(r.models.map(m => m.name), ["e5-small-v2-qint8"]);
    ovExecutor.shutdownOpenVinoExecutor();
    await sleep(150);
  });

  await test("helper failure at startup yields state 'faulted'", async () => {
    const dir = scenarioDir({ failMode: "fatal" });
    await ovExecutor.initOpenVinoExecutor(makeConfig(dir));
    const r = await ovExecutor.awaitStartupReadiness(4000);
    assert.strictEqual(r.state, "faulted", `state was ${r.state}`);
    assert.strictEqual(r.capabilities.length, 0);
    ovExecutor.shutdownOpenVinoExecutor();
    await sleep(150);
  });

  await test("readiness timeout yields 'faulted' and returns promptly", async () => {
    const dir = scenarioDir({ failMode: "silent" });
    // Large helper startup timeout so the manager does not kill it first; small
    // readiness budget so our own deadline is what fires.
    await ovExecutor.initOpenVinoExecutor(makeConfig(dir, { startupTimeoutMs: 20000 }));
    const started = Date.now();
    const r = await ovExecutor.awaitStartupReadiness(700);
    const elapsed = Date.now() - started;
    assert.strictEqual(r.state, "faulted", `state was ${r.state}`);
    assert.ok(elapsed < 4000, `readiness returned promptly (${elapsed}ms)`);
    assert.strictEqual(r.capabilities.length, 0);
    ovExecutor.shutdownOpenVinoExecutor();
    await sleep(150);
  });

  await test("shutdown during initialization aborts readiness cleanly", async () => {
    const dir = scenarioDir({ failMode: "silent" });
    await ovExecutor.initOpenVinoExecutor(makeConfig(dir, { startupTimeoutMs: 20000 }));
    const started = Date.now();
    const p = ovExecutor.awaitStartupReadiness(10000);
    // Request shutdown mid-initialisation.
    setTimeout(() => ovExecutor.shutdownOpenVinoExecutor(), 200);
    const r = await p;
    const elapsed = Date.now() - started;
    assert.strictEqual(r.state, "faulted", `state was ${r.state}`);
    assert.ok(/shutdown/i.test(r.reason), `reason mentions shutdown: ${r.reason}`);
    assert.ok(elapsed < 3000, `aborted promptly (${elapsed}ms), not after full budget`);
    await sleep(150);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Starting OpenVINO Startup Readiness Tests...");
  await runShapingTests();
  await runReadinessTests();

  console.log("\nSummary:");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
