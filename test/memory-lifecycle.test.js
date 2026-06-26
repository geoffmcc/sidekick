#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-lifecycle-test-"));
process.env.SIDEKICK_DATA_DIR = tempDir;
process.env.SIDEKICK_AUTO_MEMORY = "1";

const dbStore = require("../src/db");
const { TOOLS } = require("../src/tools");
const { sidekick_context, sidekick_memory_manage } = TOOLS;

dbStore.runPendingMigrations();

console.log("Test memory lifecycle features");

const now = new Date();
const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

const staleMemory = dbStore.upsertMemory({
  type: "fact",
  project: "lifecycle_test",
  content: "Stale memory that should expire",
  summary: "Stale memory that should expire",
  confidence: 0.7,
  source: "test",
  source_tool: "test",
  metadata: { test: "lifecycle" }
});

dbStore.db.prepare(`
  UPDATE memories
  SET last_confirmed_at = ?, last_seen_at = ?
  WHERE id = ?
`).run(ninetyDaysAgo, ninetyDaysAgo, staleMemory.id);

const recentMemory = dbStore.upsertMemory({
  type: "fact",
  project: "lifecycle_test",
  content: "Recent memory that should stay",
  summary: "Recent memory that should stay",
  confidence: 0.8,
  source: "test",
  source_tool: "test",
  metadata: { test: "lifecycle" }
});

console.log("Test getMemoryStats");
const stats = dbStore.getMemoryStats();
assert.ok(stats, "Stats should be returned");
assert.ok(typeof stats.total === "number", "Stats should have total count");
assert.ok(typeof stats.active === "number", "Stats should have active count");
assert.ok(typeof stats.disabled === "number", "Stats should have disabled count");
assert.ok(typeof stats.by_type === "object", "Stats should have by_type breakdown");
assert.ok(typeof stats.by_project === "object", "Stats should have by_project breakdown");
assert.ok(typeof stats.avg_confidence === "number", "Stats should have avg_confidence");
console.log("  ✓ Stats structure is correct");

console.log("Test expireStaleMemories");
const expireResult = dbStore.expireStaleMemories({ staleDays: 90 });
assert.ok(expireResult, "Expire should return result");
assert.ok(typeof expireResult.expired === "number", "Expire should return count");
assert.ok(expireResult.expired >= 1, "Should expire at least the stale memory");
console.log("  ✓ Expired " + expireResult.expired + " stale memories");

const staleAfterExpire = dbStore.db.prepare("SELECT * FROM memories WHERE id = ?").get(staleMemory.id);
assert.strictEqual(staleAfterExpire.enabled, 0, "Stale memory should be disabled");

const recentAfterExpire = dbStore.db.prepare("SELECT * FROM memories WHERE id = ?").get(recentMemory.id);
assert.strictEqual(recentAfterExpire.enabled, 1, "Recent memory should still be enabled");
console.log("  ✓ Recent memories preserved");

console.log("Test calculateMemoryDecay");
const freshMemory = {
  confidence: 0.8,
  times_confirmed: 5,
  last_confirmed_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  created_at: new Date().toISOString()
};
const freshDecay = dbStore.calculateMemoryDecay(freshMemory);
assert.ok(freshDecay > 0.5, "Fresh memory should have high decay score");
assert.ok(freshDecay <= 1, "Decay score should be <= 1");
console.log("  ✓ Fresh memory decay: " + freshDecay.toFixed(3));

const oldMemory = {
  confidence: 0.8,
  times_confirmed: 5,
  last_confirmed_at: ninetyDaysAgo,
  last_seen_at: ninetyDaysAgo,
  created_at: new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString()
};
const oldDecay = dbStore.calculateMemoryDecay(oldMemory);
assert.ok(oldDecay < freshDecay, "Old memory should have lower decay score");
console.log("  ✓ Old memory decay: " + oldDecay.toFixed(3));

const unconfirmedMemory = {
  confidence: 0.6,
  times_confirmed: 1,
  last_confirmed_at: null,
  last_seen_at: thirtyDaysAgo,
  created_at: thirtyDaysAgo
};
const unconfirmedDecay = dbStore.calculateMemoryDecay(unconfirmedMemory);
assert.ok(unconfirmedDecay > 0, "Unconfirmed memory should have some decay score");
console.log("  ✓ Unconfirmed memory decay: " + unconfirmedDecay.toFixed(3));

console.log("Test confirmation tracking");
const confirmTest = dbStore.upsertMemory({
  type: "preference",
  project: "lifecycle_test",
  content: "Memory to confirm",
  summary: "Memory to confirm",
  confidence: 0.7,
  source: "test",
  source_tool: "test"
});

const beforeConfirm = dbStore.db.prepare("SELECT * FROM memories WHERE id = ?").get(confirmTest.id);
assert.ok(beforeConfirm.last_confirmed_at, "Memory should have last_confirmed_at");

const confirmedAgain = dbStore.upsertMemory({
  type: "preference",
  project: "lifecycle_test",
  content: "Memory to confirm",
  summary: "Memory to confirm",
  confidence: 0.7,
  source: "test",
  source_tool: "test"
});

const afterConfirm = dbStore.db.prepare("SELECT * FROM memories WHERE id = ?").get(confirmTest.id);
assert.strictEqual(afterConfirm.times_confirmed, 2, "Times confirmed should increment");
assert.ok(new Date(afterConfirm.last_confirmed_at) >= new Date(beforeConfirm.last_confirmed_at),
  "last_confirmed_at should update on confirmation");
console.log("  ✓ Confirmation tracking works");

(async () => {
  console.log("Test exact id recall and cross-store lifecycle");
  const sessionResult = await sidekick_context({
    action: "track_session",
    project: "lifecycle_test",
    summary: "Exact id recall session for lifecycle test",
    topics: "memory,lifecycle,exact-id",
    outcome: "success"
  });
  const sessionText = sessionResult.content[0].text;
  const sessionId = sessionText.match(/id: (sess_[^)]+)/)[1];
  assert.ok(sessionId, "track_session should return a session id");

  const exactRecall = await sidekick_context({ action: "recall", query: sessionId, type: "sessions" });
  assert.ok(exactRecall.content[0].text.includes(`[Session ${sessionId}]`), "Exact session id recall should find the session");

  const disableSession = await sidekick_memory_manage({ action: "disable", id: sessionId, reason: "test_disable" });
  assert.ok(!disableSession.isError, "Legacy session disable should succeed");
  assert.ok(disableSession.content[0].text.includes("disabled"), "Disable should report success");

  const disabledRecall = await sidekick_context({ action: "recall", query: sessionId, type: "sessions" });
  assert.strictEqual(disabledRecall.content[0].text, "No relevant context found", "Disabled session should not be recalled");

  const restoreSession = await sidekick_memory_manage({ action: "restore", id: sessionId });
  assert.ok(!restoreSession.isError, "Legacy session restore should succeed");
  const restoredRecall = await sidekick_context({ action: "recall", query: sessionId, type: "sessions" });
  assert.ok(restoredRecall.content[0].text.includes(`[Session ${sessionId}]`), "Restored session should be recalled");

  const deleteSession = await sidekick_memory_manage({ action: "delete", id: sessionId, reason: "test_delete" });
  assert.ok(!deleteSession.isError, "Legacy session delete should succeed");
  const deletedRecall = await sidekick_context({ action: "recall", query: sessionId, type: "sessions" });
  assert.strictEqual(deletedRecall.content[0].text, "No relevant context found", "Deleted session should not be recalled");

  const unsupportedConfirm = await sidekick_memory_manage({ action: "confirm", id: sessionId });
  assert.ok(unsupportedConfirm.isError, "Confirm should return a clear unsupported legacy id error");
  assert.ok(unsupportedConfirm.content[0].text.includes("legacy context session"), "Unsupported error should identify legacy session");

  const structured = dbStore.upsertMemory({
    type: "fact",
    project: "lifecycle_test",
    content: "Exact structured memory recall works",
    summary: "Exact structured memory recall works",
    confidence: 0.8,
    source: "test",
    source_tool: "test"
  });
  const structuredRecall = await sidekick_context({ action: "recall", query: structured.id, type: "memories" });
  assert.ok(structuredRecall.content[0].text.includes(`[Memory ${structured.id}]`), "Exact structured memory id recall should work");
  const disableStructured = await sidekick_memory_manage({ action: "disable", id: structured.id });
  assert.ok(!disableStructured.isError, "Structured memory disable should succeed");
  const disabledStructuredRecall = await sidekick_context({ action: "recall", query: structured.id, type: "memories" });
  assert.strictEqual(disabledStructuredRecall.content[0].text, "No relevant context found", "Disabled structured memory should not be recalled by id");
  console.log("  ✓ Exact id recall and cross-store lifecycle work");

  console.log("\n✅ All lifecycle tests passed");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
