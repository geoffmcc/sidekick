#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-deferred-test-"));
process.env.SIDEKICK_DATA_DIR = tempDir;
process.env.SIDEKICK_AUTO_MEMORY = "1";
process.env.SIDEKICK_AUTO_MEMORY_MAX = "10";

const dbStore = require("../src/db");

dbStore.runPendingMigrations();

console.log("Test memory deferred features");

console.log("Test state tracking");
const mem1 = dbStore.upsertMemory({
  type: "fact",
  project: "deferred_test",
  content: "Test memory for state tracking",
  summary: "Test memory for state tracking",
  confidence: 0.8,
  source: "test",
  source_tool: "test"
});

assert.ok(mem1, "Memory should be created");
assert.strictEqual(mem1.state, "active", "New memory should be active");
console.log("  ✓ New memory has active state");

console.log("Test confirm memory");
const confirmed = dbStore.confirmMemory(mem1.id, "test_user");
assert.ok(confirmed, "Confirm should succeed");

const mem1After = dbStore.searchMemories({ project: "deferred_test", limit: 10 }).find(m => m.id === mem1.id);
assert.strictEqual(mem1After.state, "confirmed", "Memory should be confirmed");
assert.strictEqual(mem1After.confirmed_by, "test_user", "Should track who confirmed");
assert.ok(mem1After.last_confirmed_at, "Should have last_confirmed_at");
console.log("  ✓ Memory confirmed with tracking");

console.log("Test requires_confirmation flag");
const mem2 = dbStore.upsertMemory({
  type: "preference",
  project: "deferred_test",
  content: "High-value preference requiring confirmation",
  summary: "High-value preference requiring confirmation",
  confidence: 0.9,
  source: "test",
  source_tool: "test",
  requires_confirmation: true
});

assert.ok(mem2, "Memory should be created");
assert.strictEqual(mem2.state, "pending", "Memory with requires_confirmation should start as pending");
assert.strictEqual(mem2.requires_confirmation, true, "Should have requires_confirmation flag");
console.log("  ✓ Memory with requires_confirmation starts as pending");

const mem2Confirmed = dbStore.confirmMemory(mem2.id, "user");
assert.ok(mem2Confirmed, "Confirm should succeed");

const mem2After = dbStore.searchMemories({ project: "deferred_test", limit: 10 }).find(m => m.id === mem2.id);
assert.strictEqual(mem2After.state, "confirmed", "Confirmed memory should be confirmed");
console.log("  ✓ Pending memory can be confirmed");

console.log("Test pending confirmations list");
const mem3 = dbStore.upsertMemory({
  type: "decision",
  project: "deferred_test",
  content: "Another decision requiring confirmation",
  summary: "Another decision requiring confirmation",
  confidence: 0.85,
  source: "test",
  source_tool: "test",
  requires_confirmation: true
});

const pending = dbStore.getPendingConfirmations({ limit: 10 });
assert.ok(pending.length >= 1, "Should have pending confirmations");
assert.ok(pending.some(m => m.id === mem3.id), "Should include unconfirmed memory");
console.log("  ✓ Pending confirmations list works");

console.log("Test soft delete");
const deleted = dbStore.softDeleteMemory(mem1.id, "test_delete");
assert.ok(deleted, "Delete should succeed");

const mem1Deleted = dbStore.searchMemories({ project: "deferred_test", includeDisabled: true, limit: 10 }).find(m => m.id === mem1.id);
assert.strictEqual(mem1Deleted.state, "deleted", "Memory should be deleted");
assert.strictEqual(mem1Deleted.enabled, false, "Deleted memory should be disabled");
assert.ok(mem1Deleted.deleted_at, "Should have deleted_at");
assert.strictEqual(mem1Deleted.metadata.delete_reason, "test_delete", "Should track delete reason");
console.log("  ✓ Soft delete works with tracking");

console.log("Test expire memory");
const expired = dbStore.expireMemory(mem2.id, "test_expire");
assert.ok(expired, "Expire should succeed");

const mem2Expired = dbStore.searchMemories({ project: "deferred_test", includeDisabled: true, limit: 10 }).find(m => m.id === mem2.id);
assert.strictEqual(mem2Expired.state, "expired", "Memory should be expired");
assert.strictEqual(mem2Expired.enabled, false, "Expired memory should be disabled");
assert.ok(mem2Expired.expired_at, "Should have expired_at");
console.log("  ✓ Expire memory works");

console.log("Test restore memory");
const restored = dbStore.restoreMemory(mem1.id);
assert.ok(restored, "Restore should succeed");

const mem1Restored = dbStore.searchMemories({ project: "deferred_test", limit: 10 }).find(m => m.id === mem1.id);
assert.strictEqual(mem1Restored.state, "active", "Restored memory should be active");
assert.strictEqual(mem1Restored.enabled, true, "Restored memory should be enabled");
assert.strictEqual(mem1Restored.deleted_at, null, "Should clear deleted_at");
console.log("  ✓ Restore memory works");

console.log("Test list by state");
const activeMemories = dbStore.getMemoriesByState("active", { project: "deferred_test" });
assert.ok(activeMemories.length >= 1, "Should have active memories");
assert.ok(activeMemories.every(m => m.state === "active"), "All should be active");
console.log("  ✓ List by state works");

console.log("Test auto-expire");
const mem4 = dbStore.upsertMemory({
  type: "observation",
  project: "deferred_test",
  content: "Memory that will auto-expire",
  summary: "Memory that will auto-expire",
  confidence: 0.5,
  source: "test",
  source_tool: "test"
});

const setExpire = dbStore.setAutoExpire(mem4.id, 0);
assert.ok(setExpire, "Set auto-expire should succeed");

const mem4After = dbStore.searchMemories({ project: "deferred_test", limit: 10 }).find(m => m.id === mem4.id);
assert.ok(mem4After.expires_at, "Should have expires_at");

const processed = dbStore.processAutoExpirations();
assert.ok(processed.expired >= 1, "Should have expired at least one");

const mem4Expired = dbStore.searchMemories({ project: "deferred_test", includeDisabled: true, limit: 10 }).find(m => m.id === mem4.id);
assert.strictEqual(mem4Expired.state, "expired", "Auto-expired memory should be expired");
assert.strictEqual(mem4Expired.metadata.expire_reason, "auto_expire", "Should track auto-expire reason");
console.log("  ✓ Auto-expire works");

console.log("Test conflict detection respects requires_confirmation");
const protectedMem = dbStore.upsertMemory({
  type: "fact",
  project: "deferred_test",
  content: "Protected high-confidence fact",
  summary: "Protected high-confidence fact",
  confidence: 0.95,
  source: "test",
  source_tool: "test"
});

dbStore.confirmMemory(protectedMem.id, "user");
dbStore.setMemoryRequiresConfirmation(protectedMem.id, true);

const protectedAfter = dbStore.searchMemories({ project: "deferred_test", limit: 10 }).find(m => m.id === protectedMem.id);
assert.strictEqual(protectedAfter.state, "confirmed", "Should be confirmed");
assert.strictEqual(protectedAfter.requires_confirmation, true, "Should require confirmation");

const conflictingMem = dbStore.upsertMemory({
  type: "fact",
  project: "deferred_test",
  content: "Protected high-confidence fact with update",
  summary: "Protected high-confidence fact with update",
  confidence: 0.96,
  source: "test",
  source_tool: "test"
});

const protectedStill = dbStore.searchMemories({ project: "deferred_test", includeDisabled: true, limit: 10 }).find(m => m.id === protectedMem.id);
assert.strictEqual(protectedStill.state, "confirmed", "Protected memory should still be confirmed");
assert.strictEqual(protectedStill.enabled, true, "Protected memory should still be enabled");
console.log("  ✓ Confirmed memories with requires_confirmation are protected from supersession");

console.log("\n✅ All deferred features tests passed");
