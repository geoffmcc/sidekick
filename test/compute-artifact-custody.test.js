"use strict";

// B6 artifact custody: the worker HTTP upload path registers finalized artifacts
// with the platform kernel (the one custody authority), custody failures are
// surfaced rather than swallowed, and the reconciler is dry-run by default. No
// network required.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-artifact-custody");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";

delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
const kernel = require("../src/platform/kernel");
const custody = require("../src/compute/artifact-custody");

console.log("Running compute artifact custody tests...\n");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

const HASH = "a".repeat(64);

function finalizedArtifact(overrides = {}) {
  return {
    artifactId: `art_test_${Math.random().toString(36).slice(2, 10)}`,
    jobId: "job_test_1",
    artifactType: "result",
    name: "result.txt",
    storageRef: "compute/job_test_1/result.txt",
    contentType: "text/plain",
    contentHash: HASH,
    sizeBytes: 23,
    sensitivity: "private",
    state: "finalized",
    workerId: "wk_test",
    finalizedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// ---- mapping ----------------------------------------------------------------

test("compute sensitivity is mapped, not imported verbatim, into the kernel vocabulary", () => {
  // Compute defaults artifacts to "private"; the kernel column speaks
  // normal/sensitive/secret. Passing it through would seed a third vocabulary.
  assert.strictEqual(custody.mapSensitivity("private"), "sensitive");
  assert.strictEqual(custody.mapSensitivity("public"), "normal");
  assert.strictEqual(custody.mapSensitivity("secret"), "secret");
  assert.strictEqual(custody.mapSensitivity(undefined), "sensitive", "an unknown value fails safe, not open");
});

test("worker output is labelled unredacted, and the kernel id is the compute id", () => {
  const artifact = finalizedArtifact({ artifactId: "art_fixed" });
  const input = custody.buildKernelInput(artifact);
  // Nothing redacts worker bytes on the way in, so claiming otherwise would be
  // a lie the delivery path would then trust.
  assert.strictEqual(input.redaction_state, "none");
  // Deterministic id: this is what makes registration idempotent against a
  // primary-key conflict rather than a bookkeeping flag.
  assert.strictEqual(input.artifact_id, "art_fixed");
  assert.strictEqual(input.type, "compute_result");
  assert.strictEqual(input.storage_ref, artifact.storageRef);
});

// ---- registration -----------------------------------------------------------

test("a finalized artifact is registered with the kernel under its compute id", () => {
  const artifact = finalizedArtifact();
  const outcome = custody.registerComputeArtifact(artifact, null);
  assert.strictEqual(outcome.status, "registered");
  assert.strictEqual(outcome.kernel_artifact_id, artifact.artifactId, "the kernel record carries the compute id");

  const stored = kernel.getArtifact(artifact.artifactId);
  assert.ok(stored, "the artifact is in the custody authority");
  assert.strictEqual(stored.content_hash, HASH);
  assert.strictEqual(stored.sensitivity, "sensitive");
  assert.strictEqual(stored.metadata.compute_job_id, "job_test_1");
});

test("registration is idempotent, so the reconciler can run repeatedly", () => {
  const artifact = finalizedArtifact();
  assert.strictEqual(custody.registerComputeArtifact(artifact, null).status, "registered");
  const second = custody.registerComputeArtifact(artifact, null);
  assert.strictEqual(second.status, "already", "a primary-key conflict is proof of custody, not an error");
  const rows = dbStore.getDb().prepare("SELECT COUNT(*) AS n FROM platform_artifacts WHERE artifact_id = ?").get(artifact.artifactId).n;
  assert.strictEqual(rows, 1, "no duplicate custody record");
});

test("an unfinalized artifact is not registered", () => {
  // Upload leaves state "uploaded" and verified false; the kernel record is
  // insert-only, so registering unverified bytes would assert something never checked.
  const outcome = custody.registerComputeArtifact(finalizedArtifact({ state: "uploaded" }), null);
  assert.strictEqual(outcome.status, "skipped");
  assert.match(outcome.reason, /uploaded/);
});

test("an artifact with no execution is still taken into custody", () => {
  // 7 of the 10 pre-existing production artifacts have no root_execution_id.
  // Requiring the link would silently exclude the majority of real artifacts.
  const artifact = finalizedArtifact();
  const outcome = custody.registerComputeArtifact(artifact, null);
  assert.strictEqual(outcome.status, "registered");
  const stored = kernel.getArtifact(artifact.artifactId);
  assert.strictEqual(stored.execution_id, null);
  assert.strictEqual(stored.metadata.execution_link, "unknown", "unknown provenance is recorded as unknown");
});

test("a custody failure is reported, never thrown", () => {
  // A bad storage_ref is rejected by the kernel's path-safety invariant.
  const outcome = custody.registerComputeArtifact(finalizedArtifact({ storageRef: "../../etc/passwd" }), null);
  assert.strictEqual(outcome.status, "failed", "the caller gets a status rather than an exception");
  assert.ok(outcome.error && outcome.error.length > 0, "the reason is preserved for the operator");
});

test("a custody failure publishes an event even when the job has no execution", () => {
  // compute's emitComputeEvent returns early without a rootExecutionId, which is
  // exactly the case most likely to lose custody, so custody reporting bypasses it.
  const before = dbStore.getDb().prepare("SELECT COUNT(*) AS n FROM platform_execution_events WHERE event_type = 'compute.artifact_custody_failed'").get().n;
  const originalError = console.error;
  console.error = () => {};
  try {
    custody.reportCustodyFailure(finalizedArtifact(), null, "synthetic failure");
  } finally {
    console.error = originalError;
  }
  const after = dbStore.getDb().prepare("SELECT COUNT(*) AS n FROM platform_execution_events WHERE event_type = 'compute.artifact_custody_failed'").get().n;
  assert.strictEqual(after, before + 1, "the gap is visible in the event ledger");
});

// ---- reconciler -------------------------------------------------------------

function seedComputeArtifact(id, { finalized = true, executionId = null } = {}) {
  const db = dbStore.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS compute_artifacts (
    artifact_id TEXT PRIMARY KEY, job_id TEXT, attempt_id TEXT, worker_id TEXT, lease_id TEXT,
    artifact_type TEXT, name TEXT, storage_path TEXT, storage_ref TEXT, content_type TEXT,
    content_hash TEXT, size_bytes INTEGER, state TEXT, finalized_at TEXT, sensitivity TEXT,
    retention_days INTEGER, metadata_json TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS compute_jobs (
    job_id TEXT PRIMARY KEY, root_execution_id TEXT, project TEXT, task_id TEXT, session_id TEXT
  );`);
  db.prepare(`INSERT OR REPLACE INTO compute_artifacts
    (artifact_id, job_id, worker_id, artifact_type, name, storage_ref, content_type, content_hash, size_bytes, state, finalized_at, sensitivity, metadata_json, created_at)
    VALUES (?, ?, 'wk_test', 'result', 'result.txt', ?, 'text/plain', ?, 12, ?, ?, 'private', '{}', ?)`)
    .run(id, `job_${id}`, `compute/job_${id}/result.txt`, HASH, finalized ? "finalized" : "uploaded", finalized ? new Date(0).toISOString() : null, new Date(0).toISOString());
  db.prepare("INSERT OR REPLACE INTO compute_jobs (job_id, root_execution_id, project) VALUES (?, ?, ?)")
    .run(`job_${id}`, executionId, "test-project");
}

test("the reconciler is a dry run by default and writes nothing", () => {
  seedComputeArtifact("art_orphan_1");
  seedComputeArtifact("art_orphan_2");
  const plan = custody.reconcileComputeArtifacts();
  assert.strictEqual(plan.mode, "dry_run");
  assert.ok(plan.examined >= 2, "orphans are found");
  assert.strictEqual(plan.registered, 0, "a dry run registers nothing");
  assert.match(plan.note, /confirm=true/);
  assert.strictEqual(kernel.getArtifact("art_orphan_1"), null, "nothing was written");
});

test("the reconciler reports the linked/unlinked split before writing", () => {
  const plan = custody.reconcileComputeArtifacts();
  assert.strictEqual(typeof plan.linked, "number");
  assert.strictEqual(typeof plan.unlinked, "number");
  assert.strictEqual(plan.linked + plan.unlinked, plan.examined, "every examined artifact is accounted for in the split");
  assert.ok(plan.unlinked >= 2, "artifacts with no execution are counted, not hidden");
});

test("a confirmed run registers the orphans and is safe to repeat", () => {
  const confirmed = custody.reconcileComputeArtifacts({ confirm: true });
  assert.strictEqual(confirmed.mode, "confirmed");
  assert.ok(confirmed.registered >= 2, "orphans are taken into custody");
  assert.strictEqual(confirmed.failed, 0);
  assert.ok(kernel.getArtifact("art_orphan_1"), "the orphan is now in the authority");

  const again = custody.reconcileComputeArtifacts({ confirm: true });
  assert.strictEqual(again.examined, 0, "reconciled artifacts are no longer orphans");
});

test("the reconciler ignores unfinalized artifacts", () => {
  seedComputeArtifact("art_pending_1", { finalized: false });
  const plan = custody.reconcileComputeArtifacts();
  assert.strictEqual(plan.examined, 0, "only finalized artifacts are candidates for custody");
});

// ---- operator surface -------------------------------------------------------

test("the reconcile action and its confirm flag pass the tool input schema", () => {
  // Regression: the handler case was added to compute/tools.js without adding
  // the action to the zod enum, and the schema is .strict(), so the MCP layer
  // rejected the call before it ever reached the handler. Module-level tests
  // passed the whole time because they never crossed the schema boundary.
  const schema = require("../src/tools").getBuiltinRegistry().schemas().compute_jobs;
  assert.ok(schema, "compute_jobs resolves a schema from the registry");
  assert.doesNotThrow(() => schema.parse({ action: "reconcile_artifact_custody" }), "the dry-run form is accepted");
  assert.doesNotThrow(() => schema.parse({ action: "reconcile_artifact_custody", confirm: true }), "the confirmed form is accepted");
  const parsed = schema.parse({ action: "reconcile_artifact_custody", confirm: true });
  assert.strictEqual(parsed.confirm, true, "confirm survives parsing rather than being stripped");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
