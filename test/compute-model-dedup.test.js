"use strict";

// B8 compute/model dedup: one model authority, one trust ordering, no dead
// worker-state writer. Guards the deduplication itself, so the duplicate cannot
// quietly regain callers after being deprecated.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-compute-model-dedup");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";

delete require.cache[require.resolve("../src/db")];
const placement = require("../src/compute/placement");
const capabilityRouter = require("../src/compute/capability-router");
const workerManager = require("../src/compute/worker-manager");

console.log("Running compute/model dedup tests...\n");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

const SRC = path.join(__dirname, "..", "src");
function sourceFiles() {
  const files = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)) files.push({ path: full, text: fs.readFileSync(full, "utf8") });
    }
  };
  visit(SRC);
  return files;
}
function sourceText() {
  return sourceFiles().map(file => file.text).join("\n");
}

// ---- one model authority ----------------------------------------------------

test("the deprecated platform model registry has no production callers", () => {
  // The point of deprecating rather than deleting is that it stays buildable.
  // The risk of deprecating rather than deleting is that someone calls it
  // anyway, so the absence of callers is asserted rather than assumed.
  const callers = sourceFiles().filter(file => !file.path.endsWith(path.join("platform", "kernel.js")))
    .flatMap(file => [...file.text.matchAll(/\b(?:registerModel|getModelByName|deprecateModel|recordModelUsage)\(/g)]
      .map(match => `${file.path}: ${match[0]}`));
  assert.deepStrictEqual(callers, [],
    `platform_model_registry must stay caller-free; compute_models is the model authority. Found:\n${callers.join("\n")}`);
});

// ---- one trust ordering -----------------------------------------------------

test("the router uses placement's trust ordering rather than a second copy", () => {
  // The second copy omitted the legacy `private` label, so the same provider
  // ranked trusted in placement and untrusted in the router.
  assert.strictEqual(placement.TRUST_ORDER.private, 2, "placement ranks the legacy private label as trusted");
  const routerSource = fs.readFileSync(path.join(SRC, "compute", "capability-router.js"), "utf8");
  assert.ok(/require\("\.\/placement"\)/.test(routerSource), "the router imports the ordering");
  assert.ok(!/const TRUST_ORDER = \{/.test(routerSource), "the router declares no second ordering");
});

test("a provider below the required trust is not selected", () => {
  const providerRegistry = require("../src/compute/provider-registry");
  const modelRegistry = require("../src/compute/model-registry");
  const untrusted = providerRegistry.createProvider({
    displayName: "untrusted-provider", providerType: "openai-compatible",
    endpoint: "http://127.0.0.1:9/v1", trustLevel: "untrusted",
    dataClassifications: ["public", "internal", "private"], priority: 99, enabled: true,
  });
  modelRegistry.createModel({
    providerId: untrusted.providerId, providerModelName: "m1", displayName: "m1",
    capabilities: ["chat"], enabled: true,
  });

  // Default: placement treats an unspecified requirement as `trusted`, and the
  // router must agree or `explain` advertises what placement would refuse.
  const defaulted = capabilityRouter.selectProvider({ capability: "chat", dataClassification: "private" });
  assert.notStrictEqual(defaulted.provider?.providerId, untrusted.providerId,
    "an untrusted provider is not offered when trusted is required by default");

  // Explicitly asking for untrusted may select it: the filter is a floor, not a ban.
  const explicit = capabilityRouter.selectProvider({ capability: "chat", dataClassification: "private", trustLevel: "untrusted" });
  assert.strictEqual(explicit.provider?.providerId, untrusted.providerId,
    "lowering the requirement admits the provider");
});

test("fallback candidates are held to the same trust floor as primaries", () => {
  // The fallback filter already promised parity with the primary filter for
  // capability, tools, vision and context. Trust was missing from that list.
  const result = capabilityRouter.selectWithFallback({
    capability: "chat", dataClassification: "private", requiresVision: true,
  });
  for (const fb of result.fallbacks || []) {
    assert.ok(placement.TRUST_ORDER[fb.provider.trustLevel] >= placement.TRUST_ORDER.trusted,
      `fallback ${fb.provider.providerId} is below the trust floor`);
  }
});

// ---- no dead worker-state writer --------------------------------------------

test("the superseded offline writer is gone", () => {
  // It wrote only the legacy `state` column, leaving connection_state,
  // disconnected_at and last_disconnect_reason untouched and ignoring
  // admin_state preservation, so calling it would have corrupted the state
  // model that reconcileWorkerStates maintains.
  assert.strictEqual(workerManager.checkWorkersOffline, undefined, "checkWorkersOffline is removed");
  assert.strictEqual(typeof workerManager.reconcileWorkerStates, "function", "the multi-dimensional reconciler remains");
  assert.doesNotMatch(sourceText(), /checkWorkersOffline/, "no references remain in src/");
});

// ---- health_state is maintained rather than inert ---------------------------

test("health_state is earned on heartbeat and surrendered when contact lapses", () => {
  // Migration 022 backfilled the column and nothing ever wrote it again, so
  // every worker read back "unknown" permanently.
  const token = workerManager.createEnrollmentToken({ displayName: "dedup-test-worker", trustLevel: "trusted", maxConcurrentJobs: 1 });
  const enrolled = workerManager.enrollWorker({
    nodeId: "dedup-node-" + Math.random().toString(36).slice(2, 8),
    displayName: "dedup-test-worker",
    platform: "linux",
    enrollmentToken: token.token,
    executors: [{ type: "mock.inference" }],
  });
  const workerId = enrolled.worker ? enrolled.worker.workerId : enrolled.workerId;

  workerManager.heartbeat(workerId, { utilization: { cpu: 0.1 } });
  assert.strictEqual(workerManager.getWorker(workerId).healthState, "healthy",
    "a heartbeat is first-hand evidence the worker is reachable");

  // Age the heartbeat past the threshold and reconcile.
  const dbStore = require("../src/db");
  dbStore.getDb().prepare("UPDATE compute_workers SET last_heartbeat = ? WHERE worker_id = ?")
    .run(new Date(Date.now() - 3600_000).toISOString(), workerId);
  const reconciled = workerManager.reconcileWorkerStates(90000);
  assert.ok(reconciled.includes(workerId), "the stale worker is reconciled offline");
  assert.strictEqual(workerManager.getWorker(workerId).healthState, "unknown",
    "losing contact means the health is no longer known, not still healthy");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
