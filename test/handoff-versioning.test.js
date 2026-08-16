#!/usr/bin/env node

// Handoff versioning: no update may lose information. Covers the three
// confirmed pre-fix failure modes (id-based in-place clobber at version 1;
// metadata nulled by omission; kv_key updates crashing on the UNIQUE
// constraint) plus the new contract: append-only history, optimistic
// concurrency, historical get, restore-as-new-version, unarchive, and
// create/update intent separation.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-handoff-versioning-test-"));
process.env.SIDEKICK_DATA_DIR = tempDir;
process.env.SIDEKICK_AUTO_MEMORY = "1";
process.env.SIDEKICK_EMBEDDINGS = "0";

const dbStore = require("../src/db");
const { TOOLS } = require("../src/tools");

dbStore.runPendingMigrations();

function parse(result) {
  return JSON.parse(result.content[0].text);
}

(async () => {
  console.log("Test handoff versioning and no-loss guarantees");

  // --- HV.1 create → update chains versions and preserves prior content ----
  const created = parse(await TOOLS.handoff({
    action: "create",
    project: "hv-test",
    title: "Versioned plan",
    content: "Fact: version one body with the ORIGINAL-MARKER inside.",
  }));
  assert.ok(created.ok && created.handoff.id, "create should succeed");
  assert.strictEqual(created.handoff.version, 1);
  const handoffId = created.handoff.id;

  // --- HV.0 structured resume packet is stored with the handoff ------------
  const packet = {
    objective: "Preserve handoff context across sessions",
    status: "active",
    next_step: "Review the implementation",
    completed_steps: ["Created the handoff"],
    decisions: ["Use append-only versions"],
    blockers: [],
    acceptance_criteria: ["Previous content remains retrievable"],
    provenance: {
      repository: "https://github.com/geoffmcc/sidekick",
      branch: "feat/handoff-v2",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      verification: ["node test/handoff-versioning.test.js"]
    },
    evidence: [{ type: "test", label: "focused handoff test", status: "pending" }],
    artifacts: [{ type: "file", path: "test/handoff-versioning.test.js" }],
    relationships: [{ type: "implements", target: "handoff-v2" }]
  };
  const packetCreated = parse(await TOOLS.handoff({ action: "create", key: "hv-packet", project: "hv-test", content: "Fact: structured packet.", packet }));
  assert.deepStrictEqual(packetCreated.handoff.packet, packet, "structured packet must be returned intact");
  assert.strictEqual(packetCreated.handoff.links.filter(link => link.type === "evidence").length, 1, "evidence should be persisted as a first-class link");
  assert.strictEqual(packetCreated.handoff.links.filter(link => link.type === "artifact").length, 1, "artifacts should be persisted as first-class links");
  assert.strictEqual(packetCreated.handoff.links.filter(link => link.type === "relationship").length, 1, "relationships should be persisted as first-class links");
  const packetValidation = parse(await TOOLS.handoff({ action: "validate", id: packetCreated.handoff.id }));
  assert.strictEqual(packetValidation.valid, true, "complete resume packet should validate");
  const verifiedPacket = parse(await TOOLS.handoff({ action: "create", project: "hv-test", content: "Fact: provenance verification.", packet: {
    ...packet,
    provenance: {
      ...packet.provenance,
      working_directory: process.cwd(),
      branch: "HEAD",
      commit_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    }
  } }));
  const provenanceVerification = parse(await TOOLS.handoff({ action: "verify", id: verifiedPacket.handoff.id }));
  assert.strictEqual(provenanceVerification.status, "verified", "visible Git provenance should verify");
  assert.strictEqual(provenanceVerification.valid, true);
  const unverifiableVerification = parse(await TOOLS.handoff({ action: "verify", id: packetCreated.handoff.id }));
  assert.strictEqual(unverifiableVerification.status, "unverifiable", "remote-only provenance should not be guessed as verified");
  console.log("HV.0a passed: provenance verification is bounded and honest");
  const packetUpdated = parse(await TOOLS.handoff({ action: "update", id: packetCreated.handoff.id, packet: { ...packet, next_step: "Run the focused test" } }));
  assert.strictEqual(packetUpdated.handoff.version, 2, "packet-only changes must be versioned");
  const packetHistory = parse(await TOOLS.handoff({ action: "get", id: packetCreated.handoff.id, version: 1 }));
  assert.strictEqual(packetHistory.handoff.packet.next_step, "Review the implementation", "historical packet must be preserved");
  const packetRestored = parse(await TOOLS.handoff({ action: "restore", id: packetCreated.handoff.id, version: 1 }));
  assert.strictEqual(packetRestored.handoff.version, 3, "restoring a packet-only version must append a new version");
  assert.strictEqual(packetRestored.handoff.packet.next_step, "Review the implementation", "packet restore must restore historical structured state");
  console.log("HV.0 passed: structured packet, validation, and packet history");

  const updated = parse(await TOOLS.handoff({
    action: "update",
    id: handoffId,
    content: "Fact: version two body with the SECOND-MARKER inside.",
  }));
  assert.ok(updated.ok, "update should succeed");
  assert.strictEqual(updated.handoff.version, 2, "content change must increment version");
  assert.ok(updated.handoff.content.includes("SECOND-MARKER"));
  console.log("HV.1 passed: update increments version");

  // --- HV.2 prior version is preserved verbatim and retrievable ------------
  const v1 = parse(await TOOLS.handoff({ action: "get", id: handoffId, version: 1 }));
  assert.ok(v1.ok, "historical get should succeed");
  assert.ok(v1.handoff.content.includes("ORIGINAL-MARKER"), "version 1 content must be preserved verbatim");
  assert.strictEqual(v1.handoff.current, false);
  const latest = parse(await TOOLS.handoff({ action: "get", id: handoffId }));
  assert.strictEqual(latest.handoff.version, 2, "get without version returns the latest");
  console.log("HV.2 passed: history preserved and retrievable");

  // --- HV.3 metadata survives omission, updates when supplied --------------
  assert.strictEqual(updated.handoff.project, "hv-test", "project must survive an update that omits it");
  assert.strictEqual(updated.handoff.title, "Versioned plan", "title must survive an update that omits it");
  const retitled = parse(await TOOLS.handoff({ action: "update", id: handoffId, title: "Versioned plan (renamed)", content: "Fact: version three body." }));
  assert.strictEqual(retitled.handoff.title, "Versioned plan (renamed)", "supplied title must replace");
  assert.strictEqual(retitled.handoff.project, "hv-test");
  assert.strictEqual(retitled.handoff.version, 3);
  console.log("HV.3 passed: metadata COALESCE semantics");

  // --- HV.4 versions action lists full history, newest first ---------------
  const versions = parse(await TOOLS.handoff({ action: "versions", id: handoffId }));
  assert.strictEqual(versions.latest_version, 3);
  assert.deepStrictEqual(versions.versions.map(v => v.version), [3, 2, 1]);
  assert.strictEqual(versions.versions[0].current, true);
  assert.ok(versions.versions.every(v => /^[a-f0-9]{16,64}$/.test(v.hash || v.content_hash)), "every version carries its hash");
  console.log("HV.4 passed: versions action");

  // --- HV.5 optimistic concurrency ----------------------------------------
  const stale = await TOOLS.handoff({ action: "update", id: handoffId, expected_version: 2, content: "Fact: stale writer content." });
  assert.ok(stale.isError, "stale expected_version must fail");
  assert.ok(stale.content[0].text.includes("expected version 2, found 3"), stale.content[0].text);
  assert.ok(!stale.content[0].text.includes("stale writer content"), "concurrency error must not echo content");
  const fresh = parse(await TOOLS.handoff({ action: "update", id: handoffId, expected_version: 3, content: "Fact: version four body." }));
  assert.strictEqual(fresh.handoff.version, 4, "matching expected_version proceeds");
  console.log("HV.5 passed: optimistic concurrency");

  // --- HV.6 unchanged content is a metadata touch, not a version bump ------
  const touched = parse(await TOOLS.handoff({ action: "update", id: handoffId, content: "Fact: version four body." }));
  assert.strictEqual(touched.handoff.version, 4, "identical content must not bump the version");
  console.log("HV.6 passed: no-op content does not version");

  // --- HV.7 restore appends, never rewrites --------------------------------
  const restored = parse(await TOOLS.handoff({ action: "restore", id: handoffId, version: 1 }));
  assert.ok(restored.ok);
  assert.strictEqual(restored.restored_from, 1);
  assert.strictEqual(restored.handoff.version, 5, "restore creates a NEW latest version");
  assert.ok(restored.handoff.content.includes("ORIGINAL-MARKER"), "restored content matches version 1");
  const afterRestore = parse(await TOOLS.handoff({ action: "versions", id: handoffId }));
  assert.deepStrictEqual(afterRestore.versions.map(v => v.version), [5, 4, 3, 2, 1], "history intact after restore");
  const noop = parse(await TOOLS.handoff({ action: "restore", id: handoffId, version: 5 }));
  assert.strictEqual(noop.no_op, true, "restoring the current version is a no-op");
  console.log("HV.7 passed: restore is append-only");

  // --- HV.8 kv_key handoffs version without UNIQUE violations (F3) ---------
  const k1 = parse(await TOOLS.handoff({ action: "create", key: "hv-kv-handoff", project: "hv-test", content: "Fact: keyed first." }));
  assert.strictEqual(k1.handoff.version, 1);
  const k2 = parse(await TOOLS.handoff({ action: "update", key: "hv-kv-handoff", content: "Fact: keyed second, changed." }));
  assert.strictEqual(k2.handoff.version, 2, "kv_key update must version, not crash on UNIQUE(kv_key)");
  assert.strictEqual(k2.handoff.id, k1.handoff.id, "kv_key update stays on the same handoff row");
  const kHist = parse(await TOOLS.handoff({ action: "get", key: "hv-kv-handoff", version: 1 }));
  assert.ok(kHist.handoff.content.includes("keyed first"));
  console.log("HV.8 passed: kv_key version chain (F3 regression)");

  // --- HV.9 create/update intent separation --------------------------------
  const updateMissing = await TOOLS.handoff({ action: "update", id: "handoff_does_not_exist", content: "x".repeat(20) });
  assert.ok(updateMissing.isError, "update of a nonexistent handoff must error, not create");
  const createExisting = await TOOLS.handoff({ action: "create", id: handoffId, content: "Fact: someone re-creating." });
  assert.ok(createExisting.isError, "create with an existing id must error, not overwrite");
  assert.ok(createExisting.content[0].text.includes("Use update"), createExisting.content[0].text);
  console.log("HV.9 passed: create/update intents");

  // --- HV.10 raw content stored unredacted; redacted column redacts --------
  const secretish = parse(await TOOLS.handoff({ action: "create", project: "hv-test", title: "redaction probe", content: "Fact: uses api_key=TEST_API_KEY_PLACEHOLDER for the probe service." }));
  const row = dbStore.getDb().prepare("SELECT content, redacted_content FROM memory_handoffs WHERE id = ?").get(secretish.handoff.id);
  assert.ok(row.content.includes("TEST_API_KEY_PLACEHOLDER"), "raw content column preserves the artifact verbatim");
  assert.ok(!row.redacted_content.includes("TEST_API_KEY_PLACEHOLDER"), "redacted column must not carry the value");
  console.log("HV.10 passed: raw preserved, redacted derived");

  // --- HV.11 extraction stays idempotent across version bumps --------------
  const before = dbStore.getDb().prepare("SELECT COUNT(*) AS c FROM memories WHERE source_ref = ?").get(handoffId).c;
  await TOOLS.handoff({ action: "reprocess", id: handoffId });
  const after = dbStore.getDb().prepare("SELECT COUNT(*) AS c FROM memories WHERE source_ref = ?").get(handoffId).c;
  assert.strictEqual(after, before, "reprocessing the same version must not duplicate memories");
  console.log("HV.11 passed: extraction idempotency");

  // --- HV.12 archive / unarchive round trip --------------------------------
  const archived = await TOOLS.handoff({ action: "archive", id: handoffId });
  assert.ok(!archived.isError);
  assert.ok(dbStore.getHandoff(handoffId).archived_at, "archive stamps archived_at");
  const unarchived = await TOOLS.handoff({ action: "unarchive", id: handoffId });
  assert.ok(!unarchived.isError);
  assert.strictEqual(dbStore.getHandoff(handoffId).archived_at, null, "unarchive clears archived_at");
  console.log("HV.12 passed: archive/unarchive");

  // --- HV.13 compare with id summarizes the version chain ------------------
  const compare = parse(await TOOLS.handoff({ action: "compare", id: handoffId }));
  assert.strictEqual(compare.comparison.length, 5);
  assert.strictEqual(compare.comparison[0].current, true);
  console.log("HV.13 passed: compare by id");

  // --- HV.14 creation dedupe only without explicit identity ----------------
  const dedupeA = parse(await TOOLS.handoff({ action: "create", project: "hv-dedupe", content: "Fact: identical body for dedupe." }));
  const dedupeB = parse(await TOOLS.handoff({ action: "create", project: "hv-dedupe", content: "Fact: identical body for dedupe." }));
  assert.strictEqual(dedupeB.handoff.id, dedupeA.handoff.id, "identity-free identical create dedupes");
  console.log("HV.14 passed: creation dedupe");

  // --- HV.15 rejected update must not poison the KV mirror -----------------
  const kvBefore = dbStore.getKV("hv-kv-handoff")?.value;
  const stalekv = await TOOLS.handoff({ action: "update", key: "hv-kv-handoff", expected_version: 99, content: "Fact: poison attempt." });
  assert.ok(stalekv.isError, "stale kv update must fail");
  assert.strictEqual(dbStore.getKV("hv-kv-handoff")?.value, kvBefore, "KV mirror must be untouched by a rejected save");
  const kvNoContent = parse(await TOOLS.handoff({ action: "update", key: "hv-kv-handoff", content: dbStore.getKV("hv-kv-handoff").value }));
  assert.strictEqual(kvNoContent.handoff.version, 2, "re-applying the untouched KV content is a no-op version-wise");
  console.log("HV.15 passed: KV mirror written only after successful save");

  // --- HV.16 mismatched planted history row aborts the save loudly ---------
  const planted = parse(await TOOLS.handoff({ action: "create", project: "hv-test", title: "planted", content: "Fact: legitimate current content." }));
  dbStore.getDb().prepare(`
    INSERT INTO memory_handoff_versions (handoff_id, version, content, redacted_content, content_hash, created_at, superseded_at)
    VALUES (?, ?, 'WRONG-PLANTED', 'WRONG-PLANTED', 'nothash', datetime('now'), datetime('now'))
  `).run(planted.handoff.id, planted.handoff.version);
  const blocked = await TOOLS.handoff({ action: "update", id: planted.handoff.id, content: "Fact: attempted advance over planted history." });
  assert.ok(blocked.isError, "save over mismatched history must fail");
  assert.ok(blocked.content[0].text.includes("does not match the current content"), blocked.content[0].text);
  const stillV1 = parse(await TOOLS.handoff({ action: "get", id: planted.handoff.id }));
  assert.strictEqual(stillV1.handoff.version, 1, "main row must be unchanged after the refused save");
  assert.ok(stillV1.handoff.content.includes("legitimate current content"));
  console.log("HV.16 passed: history integrity check fails closed");

  // --- HV.17 restore to identical content is a no_op -----------------------
  // handoffId is at v5 with v1's content (restored in HV.7); restoring v1
  // again changes nothing and must say so.
  const identicalRestore = parse(await TOOLS.handoff({ action: "restore", id: handoffId, version: 1 }));
  assert.strictEqual(identicalRestore.no_op, true, "restoring content identical to current must be a no_op");
  assert.strictEqual(identicalRestore.handoff.version, 5, "no phantom version transition");
  console.log("HV.17 passed: identical-content restore is honest");

  // --- HV.18 purge_version: audited, historical-only, reason required ------
  const noReason = await TOOLS.handoff({ action: "purge_version", id: handoffId, version: 2 });
  assert.ok(noReason.isError && noReason.content[0].text.includes("reason"), "purge without reason must fail");
  const purgeCurrent = await TOOLS.handoff({ action: "purge_version", id: handoffId, version: 5, reason: "test" });
  assert.ok(purgeCurrent.isError && purgeCurrent.content[0].text.includes("CURRENT"), "current version must be unpurgeable");
  const purged = parse(await TOOLS.handoff({ action: "purge_version", id: handoffId, version: 2, reason: "credential remediation drill" }));
  assert.ok(purged.ok && purged.purged, "historical purge succeeds with a reason");
  const afterPurge = parse(await TOOLS.handoff({ action: "versions", id: handoffId }));
  assert.deepStrictEqual(afterPurge.versions.map(v => v.version), [5, 4, 3, 1], "only version 2 removed; rest of history intact");
  const audit = dbStore.getDb().prepare("SELECT * FROM memory_audit_events WHERE event_type = 'handoff_version_purged' AND target_id = ?").get(handoffId);
  assert.ok(audit, "purge must leave an audit event");
  assert.ok(JSON.parse(audit.details_json).reason.includes("credential remediation drill"));
  console.log("HV.18 passed: purge_version is deliberate, bounded, audited");

  console.log("\nAll handoff versioning tests passed");
  process.exit(0);
})().catch(error => {
  console.error("FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
