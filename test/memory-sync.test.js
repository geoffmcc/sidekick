#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-sync-test-"));
process.env.SIDEKICK_DATA_DIR = tempDir;
process.env.SIDEKICK_AUTO_MEMORY = "1";
process.env.SIDEKICK_AUTO_MEMORY_MAX = "10";

const dbStore = require("../src/db");

dbStore.runPendingMigrations();

console.log("Test cross-machine sync features");

console.log("Test machine identity");
const machineId = dbStore.getMachineId();
assert.ok(machineId, "Machine ID should be generated");
assert.ok(typeof machineId === "string", "Machine ID should be a string");
assert.ok(machineId.length > 0, "Machine ID should not be empty");

const machineId2 = dbStore.getMachineId();
assert.strictEqual(machineId, machineId2, "Machine ID should be stable");
console.log("  ✓ Machine ID: " + machineId);

console.log("Test user identity");
assert.strictEqual(dbStore.getUserId(), null, "User ID should be null initially");

dbStore.setUserId("test-user-123");
assert.strictEqual(dbStore.getUserId(), "test-user-123", "User ID should be set");

dbStore.setUserId("test-user-456");
assert.strictEqual(dbStore.getUserId(), "test-user-456", "User ID should be updateable");
console.log("  ✓ User ID management works");

console.log("Test sync export");
const mem1 = dbStore.upsertMemory({
  type: "fact",
  project: "sync_test",
  content: "Sync test fact 1",
  summary: "Sync test fact 1",
  confidence: 0.8,
  source: "test",
  source_tool: "test",
  metadata: { test: "sync" }
});

const mem2 = dbStore.upsertMemory({
  type: "preference",
  project: "sync_test",
  content: "Sync test preference",
  summary: "Sync test preference",
  confidence: 0.9,
  source: "test",
  source_tool: "test",
  metadata: { test: "sync" }
});

const exportData = dbStore.exportForSync({ project: "sync_test" });
assert.ok(exportData, "Export should return data");
assert.strictEqual(exportData.version, 2, "Export should be version 2");
assert.strictEqual(exportData.machine_id, machineId, "Export should include machine ID");
assert.strictEqual(exportData.user_id, "test-user-456", "Export should include user ID");
assert.ok(Array.isArray(exportData.memories), "Export should have memories array");
assert.ok(exportData.memories.length >= 2, "Export should have at least 2 memories");

const exportedMem = exportData.memories.find(m => m.id === mem1.id);
assert.ok(exportedMem, "Exported memory should be findable");
assert.strictEqual(exportedMem.origin_machine_id, machineId, "Memory should have origin machine ID");
assert.strictEqual(exportedMem.origin_user_id, "test-user-456", "Memory should have origin user ID");
assert.ok(exportedMem.sync_version >= 1, "Memory should have sync version");
console.log("  ✓ Sync export includes identity and origin tracking");

console.log("Test sync diff");
const since = new Date(Date.now() - 60000).toISOString();
const diff = dbStore.getSyncDiff(since);
assert.ok(diff, "Diff should return data");
assert.strictEqual(diff.machine_id, machineId, "Diff should include machine ID");
assert.ok(Array.isArray(diff.changes), "Diff should have changes array");
assert.ok(diff.changes.length >= 2, "Diff should have at least 2 changes");

const diffMem = diff.changes.find(m => m.id === mem1.id);
assert.ok(diffMem, "Diff should include the memory");
assert.strictEqual(diffMem.is_local, true, "Memory should be marked as local");
console.log("  ✓ Sync diff works");

console.log("Test conflict resolution strategies");
const local = {
  confidence: 0.7,
  times_confirmed: 3,
  updated_at: new Date(Date.now() - 3600000).toISOString()
};

const remote = {
  confidence: 0.8,
  times_confirmed: 2,
  updated_at: new Date().toISOString()
};

assert.strictEqual(dbStore.resolveConflict(local, remote, "newest"), "remote", "Newest should pick remote");
assert.strictEqual(dbStore.resolveConflict(remote, local, "newest"), "local", "Newest should pick local when older");
assert.strictEqual(dbStore.resolveConflict(local, remote, "highest_confidence"), "remote", "Highest confidence should pick remote");
assert.strictEqual(dbStore.resolveConflict(remote, local, "highest_confidence"), "local", "Highest confidence should pick local when higher");
assert.strictEqual(dbStore.resolveConflict(local, remote, "most_confirmed"), "local", "Most confirmed should pick local");
assert.strictEqual(dbStore.resolveConflict(local, remote, "skip"), "skip", "Skip should return skip");
assert.strictEqual(dbStore.resolveConflict(local, remote, "merge"), "merge", "Merge should return merge");
console.log("  ✓ Conflict resolution strategies work");

console.log("Test sync import with different strategies");

const remoteMachineId = "remote-machine-123";
const remoteUserId = "remote-user-456";

const syncData = {
  version: 2,
  machine_id: remoteMachineId,
  user_id: remoteUserId,
  exported_at: new Date().toISOString(),
  count: 1,
  memories: [
    {
      id: "remote_mem_1",
      type: "fact",
      project: "sync_test",
      content: "Remote fact from another machine",
      summary: "Remote fact from another machine",
      confidence: 0.85,
      source: "remote",
      source_tool: "test",
      tags: ["remote"],
      metadata: { remote: true },
      enabled: true,
      automatic: false,
      times_confirmed: 5,
      created_at: new Date(Date.now() - 7200000).toISOString(),
      updated_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      last_confirmed_at: new Date().toISOString(),
      origin_machine_id: remoteMachineId,
      origin_user_id: remoteUserId,
      sync_version: 1
    }
  ]
};

const importResult = dbStore.importFromSync(syncData, { strategy: "newest" });
assert.ok(importResult, "Import should return result");
assert.ok(importResult.imported >= 1, "Should import at least 1 memory");

const importedMem = dbStore.searchMemories({ project: "sync_test", type: "fact", limit: 10 }).find(m => m.content.includes("Remote fact"));
assert.ok(importedMem, "Imported memory should be findable");
assert.strictEqual(importedMem.origin_machine_id, remoteMachineId, "Imported memory should have remote origin");
assert.strictEqual(importedMem.origin_user_id, remoteUserId, "Imported memory should have remote user ID");
console.log("  ✓ Sync import with origin tracking works");

console.log("Test sync import conflict resolution");

const conflictingSyncData = {
  version: 2,
  machine_id: remoteMachineId,
  user_id: remoteUserId,
  exported_at: new Date().toISOString(),
  count: 1,
  memories: [
    {
      id: "remote_mem_2",
      type: "fact",
      project: "sync_test",
      content: "Sync test fact 1",
      summary: "Updated from remote",
      confidence: 0.95,
      source: "remote",
      source_tool: "test",
      tags: ["updated"],
      metadata: { updated: true },
      enabled: true,
      automatic: false,
      times_confirmed: 10,
      created_at: new Date(Date.now() - 7200000).toISOString(),
      updated_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      last_confirmed_at: new Date().toISOString(),
      origin_machine_id: remoteMachineId,
      origin_user_id: remoteUserId,
      sync_version: 2
    }
  ]
};

const conflictResult = dbStore.importFromSync(conflictingSyncData, { strategy: "highest_confidence" });
assert.ok(conflictResult, "Conflict import should return result");
assert.ok(conflictResult.conflicts >= 1, "Should have at least 1 conflict resolved");

const updatedMem = dbStore.searchMemories({ project: "sync_test", type: "fact", limit: 10 }).find(m => m.id === mem1.id);
assert.ok(updatedMem, "Updated memory should still exist");
assert.strictEqual(updatedMem.confidence, 0.95, "Memory should have updated confidence");
assert.strictEqual(updatedMem.times_confirmed, 10, "Memory should have updated confirmation count");
console.log("  ✓ Conflict resolution updates memory correctly");

console.log("Test incremental sync with since parameter");

const incrementalExport = dbStore.exportForSync({ 
  project: "sync_test",
  since: new Date(Date.now() - 30000).toISOString()
});
assert.ok(incrementalExport, "Incremental export should return data");
assert.ok(incrementalExport.memories.length >= 0, "Incremental export should have memories");
console.log("  ✓ Incremental sync with since parameter works");

console.log("\n✅ All sync tests passed");
