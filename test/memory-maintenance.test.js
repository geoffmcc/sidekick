"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-memory-maintenance-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
const dbStore = require("../src/db");
dbStore.runPendingMigrations();

function insertMemory(id, project, content, extra = {}) {
  const now = new Date().toISOString();
  dbStore.getDb().prepare(`INSERT INTO memories (id, type, project, content, summary, metadata_json, enabled, automatic, times_confirmed, created_at, updated_at, last_seen_at, state, requires_confirmation, current, confidence)
    VALUES (?, ?, ?, ?, ?, '{}', 1, 1, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(id, extra.type || "observation", project, content, content, extra.times_confirmed || 0, now, now, now, extra.state || "active", extra.requires_confirmation ? 1 : 0, extra.confidence || 0.5);
}

test("memory maintenance previews exact duplicates without mutation and applies once", () => {
  insertMemory("mm_a", "maintenance_a", "same observation", { confidence: 0.4 });
  insertMemory("mm_b", "maintenance_a", "same  observation", { confidence: 0.9 });
  insertMemory("mm_other", "maintenance_b", "same observation");
  const preview = dbStore.memoryMaintenancePreview({ project: "maintenance_a", maxCandidates: 10 });
  assert.equal(preview.candidates.memories.length, 1);
  assert.deepEqual(preview.candidates.memories[0], { retain_id: "mm_b", duplicate_ids: ["mm_a"] });
  assert.equal(dbStore.getDb().prepare("SELECT enabled FROM memories WHERE id = 'mm_a'").get().enabled, 1);
  const result = dbStore.applyMemoryMaintenance(preview.run_id);
  assert.deepEqual(result.mutations.soft_deleted_memory_ids, ["mm_a"]);
  const changed = dbStore.getDb().prepare("SELECT enabled, current, state, supersedes_id FROM memories WHERE id = 'mm_a'").get();
  assert.deepEqual(changed, { enabled: 0, current: 0, state: "superseded", supersedes_id: "mm_b" });
  assert.equal(dbStore.getDb().prepare("SELECT enabled FROM memories WHERE id = 'mm_other'").get().enabled, 1);
  assert.equal(dbStore.applyMemoryMaintenance(preview.run_id).idempotent, true);
});

test("maintenance protects durable/confirmed memories and bounds candidate plans", () => {
  insertMemory("mm_fact_a", "maintenance_protected", "same fact", { type: "fact" });
  insertMemory("mm_fact_b", "maintenance_protected", "same fact", { type: "fact" });
  insertMemory("mm_confirmed_a", "maintenance_protected", "same observed", { times_confirmed: 2 });
  insertMemory("mm_confirmed_b", "maintenance_protected", "same observed", { times_confirmed: 2 });
  const preview = dbStore.memoryMaintenancePreview({ project: "maintenance_protected", maxCandidates: 10 });
  assert.equal(preview.candidate_count, 0);
  insertMemory("mm_c", "maintenance_a", "another observation", { confidence: 0.4 });
  insertMemory("mm_d", "maintenance_a", "another observation", { confidence: 0.9 });
  insertMemory("mm_e", "maintenance_a", "third observation", { confidence: 0.4 });
  insertMemory("mm_f", "maintenance_a", "third observation", { confidence: 0.9 });
  assert.throws(() => dbStore.memoryMaintenancePreview({ project: "maintenance_a", maxCandidates: 1 }), /candidate limit/i);
});

test("maintenance reports redundant historical handoff versions and requires explicit purge approval", () => {
  const handoff = dbStore.saveHandoff({ id: "mm_handoff", project: "maintenance_handoff", content: "one", packet: { objective: "x", status: "active" } });
  dbStore.saveHandoff({ id: handoff.id, project: handoff.project, content: "two", packet: { objective: "x", status: "active" } });
  const old = "2000-01-01T00:00:00.000Z";
  dbStore.getDb().prepare("UPDATE memory_handoff_versions SET content_hash = 'redundant', created_at = ? WHERE handoff_id = ? AND version = 1").run(old, handoff.id);
  dbStore.getDb().prepare("INSERT INTO memory_handoff_versions (handoff_id, version, title, project, source, task_id, content, redacted_content, content_hash, created_at, superseded_at, packet_json) VALUES (?, 99, 'x', ?, 'test', NULL, 'x', 'x', 'redundant', ?, ?, '{}')").run(handoff.id, handoff.project, old, old);
  const preview = dbStore.memoryMaintenancePreview({ project: "maintenance_handoff", handoffRetentionDays: 1 });
  assert.equal(preview.candidates.handoff_versions.length, 1);
  assert.throws(() => dbStore.applyMemoryMaintenance(preview.run_id, { purgeHandoffVersions: true }), /explicit purge_approved/i);
  const result = dbStore.applyMemoryMaintenance(preview.run_id, { purgeHandoffVersions: true, purgeApproved: true });
  assert.equal(result.mutations.purged_handoff_versions.length, 1);
  assert.ok(dbStore.getDb().prepare("SELECT 1 FROM memory_audit_events WHERE event_type = 'memory_maintenance_applied' AND target_id = ?").get(preview.run_id));
});

test("maintenance rolls back and audits a bounded execution failure", () => {
  insertMemory("mm_fail_a", "maintenance_failure", "will roll back", { confidence: 0.4 });
  insertMemory("mm_fail_b", "maintenance_failure", "will roll back", { confidence: 0.9 });
  const preview = dbStore.memoryMaintenancePreview({ project: "maintenance_failure" });
  assert.throws(() => dbStore.applyMemoryMaintenance(preview.run_id, { maxExecutionMs: -1 }), /time limit/i);
  assert.equal(dbStore.getDb().prepare("SELECT enabled FROM memories WHERE id = 'mm_fail_a'").get().enabled, 1);
  assert.equal(dbStore.getMemoryMaintenanceRun(preview.run_id).state, "failed");
  assert.ok(dbStore.getDb().prepare("SELECT 1 FROM memory_audit_events WHERE event_type = 'memory_maintenance_failed' AND target_id = ?").get(preview.run_id));
});
