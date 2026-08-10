const assert = require("assert");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-execution-claims-" + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = DATA_DIR;

delete require.cache[require.resolve("../src/db")];
delete require.cache[require.resolve("../src/platform/kernel")];
delete require.cache[require.resolve("../src/platform/kernel-schema")];

const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const platformKernel = require("../src/platform/kernel");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function cleanup() {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

function createExecution(state, opts = {}) {
  const exec = platformKernel.createExecution({ operation_type: opts.operation_type || "claim_test", source: "test", ...opts });
  let current = "created";
  const paths = {
    queued: ["queued"],
    running: ["queued", "running"],
    waiting: ["queued", "running", "waiting"],
    completed: ["queued", "running", "completed"],
  };
  for (const next of paths[state] || []) {
    platformKernel.transitionExecution(exec.execution_id, next, { source: "test", reason: "test setup" });
    current = next;
  }
  return exec.execution_id;
}

function expireLease(executionId) {
  const past = new Date(Date.now() - 60000).toISOString();
  dbStore.getDb().prepare("UPDATE platform_execution_claims SET lease_expires_at = ? WHERE execution_id = ?").run(past, executionId);
}

// XC.1: claim validates the execution
test("XC.1: claim requires a live, non-terminal execution", () => {
  assert.strictEqual(platformKernel.claimExecution({ execution_id: "exec_missing", claimed_by: "w1" }).code, "execution_not_found");
  const done = createExecution("completed");
  const res = platformKernel.claimExecution({ execution_id: done, claimed_by: "w1" });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, "execution_terminal");
  assert.throws(() => platformKernel.claimExecution({ execution_id: done }), /claimed_by/);
});

// XC.2: fresh claim wins with epoch 1 and a lease
test("XC.2: fresh claim sets claimant, epoch and lease", () => {
  const id = createExecution("queued");
  const res = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-a" });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.claim.claimed_by, "worker-a");
  assert.strictEqual(res.claim.claim_epoch, 1);
  assert.ok(res.claim.lease_expires_at > new Date().toISOString());
  assert.strictEqual(res.claim.cancel_requested, false);
  assert.ok(platformKernel.getExecution(id).heartbeat_at);
});

// XC.3: second claimant loses while the lease is live
test("XC.3: concurrent claim is idempotent - one winner", () => {
  const id = createExecution("queued");
  assert.strictEqual(platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-a" }).ok, true);
  const loser = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-b" });
  assert.strictEqual(loser.ok, false);
  assert.strictEqual(loser.code, "claim_held");
  assert.strictEqual(loser.claimed_by, "worker-a");
});

// XC.4: expired lease is reclaimable with an epoch bump
test("XC.4: expired lease reclaim bumps the epoch", () => {
  const id = createExecution("running");
  platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-a" });
  expireLease(id);
  const res = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-b" });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.claim.claimed_by, "worker-b");
  assert.strictEqual(res.claim.claim_epoch, 2);
});

// XC.5: lease renewal is fenced by claimant + epoch
test("XC.5: renew succeeds for the holder, fails for stale claimants", () => {
  const id = createExecution("running");
  const claim = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-a" }).claim;
  const renewed = platformKernel.renewExecutionLease({ execution_id: id, claimed_by: "worker-a", claim_epoch: claim.claim_epoch });
  assert.strictEqual(renewed.ok, true);
  const stale = platformKernel.renewExecutionLease({ execution_id: id, claimed_by: "worker-a", claim_epoch: claim.claim_epoch - 1 });
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.code, "lease_superseded");
  const wrongWorker = platformKernel.renewExecutionLease({ execution_id: id, claimed_by: "worker-b", claim_epoch: claim.claim_epoch });
  assert.strictEqual(wrongWorker.ok, false);
});

// XC.6: checkpoint writes are fenced and round-trip
test("XC.6: checkpoint is fenced by claimant + epoch", () => {
  const id = createExecution("running");
  const claim = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-a" }).claim;
  const ok = platformKernel.checkpointExecution({ execution_id: id, claimed_by: "worker-a", claim_epoch: claim.claim_epoch, checkpoint: { step: 2, cursor: "row-40" } });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(platformKernel.getExecutionClaim(id).checkpoint, { step: 2, cursor: "row-40" });
  const stale = platformKernel.checkpointExecution({ execution_id: id, claimed_by: "worker-b", claim_epoch: claim.claim_epoch, checkpoint: { step: 99 } });
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.code, "checkpoint_rejected");
  assert.deepStrictEqual(platformKernel.getExecutionClaim(id).checkpoint, { step: 2, cursor: "row-40" });
});

// XC.7: a superseded claimant cannot write after reclaim
test("XC.7: stale claimant is write-fenced after reclaim", () => {
  const id = createExecution("running");
  const first = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-a" }).claim;
  expireLease(id);
  platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-b" });
  assert.strictEqual(platformKernel.checkpointExecution({ execution_id: id, claimed_by: "worker-a", claim_epoch: first.claim_epoch, checkpoint: { late: true } }).ok, false);
  assert.strictEqual(platformKernel.renewExecutionLease({ execution_id: id, claimed_by: "worker-a", claim_epoch: first.claim_epoch }).ok, false);
  assert.strictEqual(platformKernel.releaseExecutionClaim({ execution_id: id, claimed_by: "worker-a", claim_epoch: first.claim_epoch }).ok, false);
});

// XC.8: cancellation is a cooperative flag surfaced through claims
test("XC.8: cancel request is visible to claimants", () => {
  const id = createExecution("queued");
  const res = platformKernel.requestExecutionCancel(id, { reason: "operator cancel" });
  assert.strictEqual(res.cancel_requested, true);
  const claim = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-a" });
  assert.strictEqual(claim.ok, true);
  assert.strictEqual(claim.claim.cancel_requested, true);
  assert.throws(() => platformKernel.requestExecutionCancel("exec_missing"), /not found/);
  const events = dbStore.getDb().prepare("SELECT COUNT(*) AS c FROM platform_execution_events WHERE event_type = 'execution.cancel_requested' AND execution_id = ?").get(id);
  assert.strictEqual(events.c, 1);
});

// XC.9: release clears the lease and the execution is claimable again
test("XC.9: release makes the execution claimable again", () => {
  const id = createExecution("running");
  const claim = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-a" }).claim;
  assert.strictEqual(platformKernel.releaseExecutionClaim({ execution_id: id, claimed_by: "worker-a", claim_epoch: claim.claim_epoch }).ok, true);
  const again = platformKernel.claimExecution({ execution_id: id, claimed_by: "worker-b" });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.claim.claim_epoch, claim.claim_epoch + 1);
});

// XC.10: recovery orphans expired active claims and releases the rest
test("XC.10: recovery scan orphans expired running claims", () => {
  const runningId = createExecution("running");
  platformKernel.claimExecution({ execution_id: runningId, claimed_by: "worker-dead" });
  expireLease(runningId);
  const createdId = createExecution("queued");
  platformKernel.transitionExecution(createdId, "blocked", { source: "test", reason: "test setup" });
  platformKernel.claimExecution({ execution_id: createdId, claimed_by: "worker-dead" });
  expireLease(createdId);
  const liveId = createExecution("running");
  platformKernel.claimExecution({ execution_id: liveId, claimed_by: "worker-live" });

  const result = platformKernel.recoverOrphanedExecutions({ source: "test" });
  assert.deepStrictEqual(result.orphaned, [runningId]);
  assert.deepStrictEqual(result.released, [createdId]);
  assert.strictEqual(platformKernel.getExecution(runningId).state, "orphaned");
  assert.strictEqual(platformKernel.getExecutionClaim(runningId).claimed_by, null);
  assert.strictEqual(platformKernel.getExecutionClaim(liveId).claimed_by, "worker-live");

  // the orphaned execution can be re-queued and re-claimed
  platformKernel.transitionExecution(runningId, "queued", { source: "test", reason: "re-queue after orphan" });
  const reclaim = platformKernel.claimExecution({ execution_id: runningId, claimed_by: "worker-new" });
  assert.strictEqual(reclaim.ok, true);
  const events = dbStore.getDb().prepare("SELECT payload_json FROM platform_execution_events WHERE event_type = 'execution.claims_recovered' ORDER BY rowid DESC LIMIT 1").get();
  assert.deepStrictEqual(JSON.parse(events.payload_json), { orphaned: 1, released: 1 });
});

// XC.11: lease_ms is bounds-checked so leases cannot be born expired or overflow ISO years
test("XC.11: lease_ms bounds are enforced", () => {
  const id = createExecution("queued");
  for (const bad of [-60000, 0, 999, 1.5, NaN, Infinity, 86400001, 1e15]) {
    assert.throws(() => platformKernel.claimExecution({ execution_id: id, claimed_by: "w", lease_ms: bad }), /lease_ms/);
  }
  const claim = platformKernel.claimExecution({ execution_id: id, claimed_by: "w", lease_ms: 1000 }).claim;
  assert.throws(() => platformKernel.renewExecutionLease({ execution_id: id, claimed_by: "w", claim_epoch: claim.claim_epoch, lease_ms: -1 }), /lease_ms/);
  assert.strictEqual(platformKernel.renewExecutionLease({ execution_id: id, claimed_by: "w", claim_epoch: claim.claim_epoch, lease_ms: 86400000 }).ok, true);
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
