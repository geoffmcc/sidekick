"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-continuity-"));
process.env.SIDEKICK_DATA_DIR = path.join(root, "data");
process.env.SIDEKICK_DB_FILE = path.join(root, "data", "sidekick.db");
process.env.SIDEKICK_EMBEDDINGS = "0";
const store = require("../src/db");
const identity = require("../src/core/identity");
const resumeFamily = require("../src/tools/families/resume");
const sessionFamily = require("../src/tools/families/memory-session");
const { dispatchTestTool } = require("../src/tools/dispatcher");
const resumeDescriptor = resumeFamily.descriptors.find(descriptor => descriptor.name === "resume");
const sessionDescriptor = sessionFamily.descriptors.find(descriptor => descriptor.name === "session");
const invokeResume = args => dispatchTestTool({ descriptor: resumeDescriptor, args, context: { source: "test" } });
const invokeSession = args => dispatchTestTool({ descriptor: sessionDescriptor, args, context: { source: "test" } });
const { extractHandoffMemories } = require("../src/tools/families/memory-handoff");
const { callMcpTool } = require("../src/tools/dispatcher");
const toolContext = require("../src/tools/context");
const platformKernel = require("../src/platform/kernel");
const projectAccess = require("../src/core/project-access");
toolContext.setExecutionSource("test");
store.runPendingMigrations();
const resumeOwner = identity.bootstrapOwner({ username: "resume_scope_admin", password: "a sufficiently long resume scope password" });
function grantResumeRead(principalId, project) {
  if (!platformKernel.getProject(project)) platformKernel.registerProject({ project_id: project, owner_actor_id: resumeOwner.principal_id });
  projectAccess.grantProjectAccess({ actorPrincipalId: resumeOwner.principal_id, principalId, project, accessLevel: "read" });
}
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init");
fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
git("add", "tracked.txt");
git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");

test.after(() => {
  store.closeDatabase();
  const owned = path.resolve(root);
  assert.ok(owned.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(owned, { recursive: true, force: true });
});

let sequence = 0;
function create(evidence = [{ type: "test", label: "fixture assertion", status: "passed", observed_at: new Date().toISOString() }], { project = "continuity", working_directory = repo } = {}) {
  const fixtureGit = (...args) => execFileSync("git", ["-C", working_directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return store.saveHandoff({ project, content: `Decision: preserve verified work (fixture ${++sequence}).`, packet: {
    objective: "Continue the fixture task", status: "active", next_step: "Finish the remaining assertion",
    completed_steps: ["Initialized fixture"], decisions: ["Retain existing storage"],
    acceptance_criteria: ["Independent receiver sees persisted state"], evidence,
    provenance: { working_directory, commit_sha: fixtureGit("rev-parse", "HEAD"), branch: fixtureGit("branch", "--show-current") },
  } });
}

function ready(evidence, options) {
  const h = create(evidence, options);
  store.captureHandoffCheckpoint(h.id, { working_directory: options?.working_directory || repo });
  store.transitionHandoff(h.id, "ready");
  store.refreshHandoffEvidence(h.id, { working_directory: options?.working_directory || repo });
  return h;
}

test("checkpoint and journal roll back together when event persistence fails", () => {
  const h = create();
  const db = store.getDb();
  db.exec("CREATE TEMP TRIGGER reject_checkpoint BEFORE INSERT ON memory_handoff_events WHEN NEW.event_type = 'checkpoint_captured' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
  try {
    assert.throws(() => store.captureHandoffCheckpoint(h.id, { working_directory: repo }), /injected event failure/);
    assert.equal(store.getHandoff(h.id).checkpoint, null, "failed checkpoint must not become authoritative");
    assert.equal(store.listHandoffEvents(h.id).filter(e => e.event_type === "checkpoint_captured").length, 0);
  } finally { db.exec("DROP TRIGGER reject_checkpoint"); }
  assert.ok(store.captureHandoffCheckpoint(h.id, { working_directory: repo }).checkpoint_hash);
  assert.equal(store.listHandoffEvents(h.id).filter(e => e.event_type === "checkpoint_captured").length, 1);
});

test("handoff creation and version updates roll back when journal persistence fails", () => {
  const db = store.getDb();
  const original = create();
  const before = store.getHandoff(original.id);
  const historyBefore = store.listHandoffVersions(original.id);
  const eventsBefore = store.listHandoffEvents(original.id);

  db.exec("CREATE TEMP TRIGGER reject_handoff_write BEFORE INSERT ON memory_handoff_events WHEN NEW.event_type IN ('created', 'updated') BEGIN SELECT RAISE(ABORT, 'injected handoff event failure'); END");
  try {
    assert.throws(() => store.saveHandoff({ id: original.id, project: original.project, content: "Changed after a failed write", packet: { ...original.packet, next_step: "A different continuation" }, expectedVersion: original.version }), /injected handoff event failure/);
    assert.deepEqual(store.getHandoff(original.id), before, "an update error must not leave new content or version state");
    assert.deepEqual(store.listHandoffVersions(original.id), historyBefore, "failed updates must not leave a history snapshot");
    assert.deepEqual(store.listHandoffEvents(original.id), eventsBefore, "failed updates must not advance the journal");

    assert.throws(() => store.saveHandoff({ id: "failed_handoff_create", project: "continuity", content: "New handoff that must not persist", packet: { objective: "Test atomic create", status: "active", next_step: "Retry after trigger removal" } }), /injected handoff event failure/);
    assert.equal(store.getHandoff("failed_handoff_create"), null, "a create error must not leave an unjournaled handoff");
    assert.deepEqual(store.listHandoffEvents("failed_handoff_create"), []);
  } finally { db.exec("DROP TRIGGER reject_handoff_write"); }

  const updated = store.saveHandoff({ id: original.id, project: original.project, content: "Retry after event storage recovers", packet: { ...original.packet, next_step: "Retry succeeded" }, expectedVersion: original.version });
  assert.equal(updated.version, original.version + 1);
  assert.equal(store.listHandoffEvents(original.id).filter(event => event.event_type === "updated").length, 1);
  const created = store.saveHandoff({ id: "failed_handoff_create", project: "continuity", content: "Retry create after event storage recovers", packet: { objective: "Test atomic create", status: "active", next_step: "Created with journal" } });
  assert.ok(created);
  assert.equal(store.listHandoffEvents(created.id).filter(event => event.event_type === "created").length, 1);
});

test("task session state and its audit record roll back together", () => {
  const db = store.getDb();
  db.exec("CREATE TEMP TRIGGER reject_task_session_audit BEFORE INSERT ON memory_audit_events WHEN NEW.event_type = 'task_session_saved' BEGIN SELECT RAISE(ABORT, 'injected session audit failure'); END");
  try {
    assert.throws(() => store.saveTaskSession({ id: "audit_atomic_session", goal: "Preserve session state", state: "active" }), /injected session audit failure/);
    assert.equal(store.getTaskSession("audit_atomic_session"), null, "a failed audit must roll back a new task session");
  } finally { db.exec("DROP TRIGGER reject_task_session_audit"); }
  db.exec("CREATE TEMP TRIGGER suppress_task_session_audit BEFORE INSERT ON memory_audit_events WHEN NEW.event_type = 'task_session_saved' BEGIN SELECT RAISE(IGNORE); END");
  try {
    assert.throws(() => store.saveTaskSession({ id: "audit_atomic_session", goal: "Preserve session state", state: "active" }), /was not persisted/);
    assert.equal(store.getTaskSession("audit_atomic_session"), null, "a suppressed audit must also roll back the session");
  } finally { db.exec("DROP TRIGGER suppress_task_session_audit"); }
  const saved = store.saveTaskSession({ id: "audit_atomic_session", goal: "Preserve session state", state: "active" });
  assert.equal(saved.id, "audit_atomic_session");
  assert.equal(store.getDb().prepare("SELECT COUNT(*) AS count FROM memory_audit_events WHERE event_type = 'task_session_saved' AND target_id = ?").get(saved.id).count, 1);
});

test("task session end timestamp preserves omission and clears explicit null atomically", () => {
  const endedAt = "2026-01-01T00:00:00.000Z";
  const session = store.saveTaskSession({ id: "session_timestamp", goal: "Resume without a terminal timestamp", state: "completed", ended_at: endedAt });
  assert.equal(store.saveTaskSession({ id: session.id, state: "completed", final_summary: "Updated summary" }).ended_at, endedAt);
  store.getDb().exec("CREATE TEMP TRIGGER reject_timestamp_audit BEFORE INSERT ON memory_audit_events WHEN NEW.event_type = 'task_session_saved' BEGIN SELECT RAISE(ABORT, 'injected timestamp audit failure'); END");
  try {
    assert.throws(() => store.saveTaskSession({ id: session.id, state: "active", ended_at: null }), /injected timestamp audit failure/);
    assert.equal(store.getTaskSession(session.id).ended_at, endedAt);
    assert.equal(store.getTaskSession(session.id).state, "completed");
  } finally { store.getDb().exec("DROP TRIGGER reject_timestamp_audit"); }
  assert.equal(store.saveTaskSession({ id: session.id, state: "active", ended_at: null }).ended_at, null);
  assert.equal(store.getTaskSession(session.id).ended_at, null);
});

test("session updates and linked handoff versions roll back together", async () => {
  const session = store.saveTaskSession({ id: "session_handoff_atomic", goal: "Keep session and handoff aligned", project: "continuity", working_directory: repo, current_plan: "Original plan", next_step: "Original next step" });
  const handoff = store.saveHandoff({ id: "handoff_session_handoff_atomic", project: session.project, task_id: session.id, content: "Original continuation", packet: {
    objective: session.goal, summary: "Original continuation", status: "active", next_step: session.next_step,
    completed_steps: [], decisions: [], acceptance_criteria: ["Session and handoff remain aligned"],
    evidence: [{ type: "test", label: "fixture", status: "passed", observed_at: new Date().toISOString() }],
    provenance: { working_directory: repo, commit_sha: git("rev-parse", "HEAD"), branch: git("branch", "--show-current") },
  } });
  const before = store.getTaskSession(session.id);
  store.getDb().exec("CREATE TEMP TRIGGER reject_session_handoff_update BEFORE INSERT ON memory_handoff_events WHEN NEW.handoff_id = 'handoff_session_handoff_atomic' AND NEW.event_type = 'updated' BEGIN SELECT RAISE(ABORT, 'injected linked handoff failure'); END");
  try {
    const failedUpdate = await invokeSession({ action: "update", id: session.id, current_plan: "Changed plan", next_step: "Changed next step" });
    assert.equal(failedUpdate.isError, true, "linked handoff failure must be reported by governed dispatch");
    assert.deepEqual(store.getTaskSession(session.id), before, "a failed linked handoff update must roll back the task session update");
    assert.equal(store.getHandoff(handoff.id).version, handoff.version, "a failed update must preserve the prior handoff version");
  } finally { store.getDb().exec("DROP TRIGGER reject_session_handoff_update"); }
  const result = await invokeSession({ action: "update", id: session.id, current_plan: "Changed plan", next_step: "Changed next step" });
  assert.equal(result.isError, undefined);
  assert.equal(store.getTaskSession(session.id).current_plan, "Changed plan");
  const updated = store.getHandoff(handoff.id);
  assert.equal(updated.version, handoff.version + 1);
  assert.equal(updated.packet.next_step, "Changed next step");
});

test("resuming a partial task session does not leave its linked handoff completed", async () => {
  const session = store.saveTaskSession({ id: "session_partial_resume", goal: "Continue partial work", project: "continuity", state: "completed", outcome: "partial", acceptance_state: "blocked", ended_at: new Date().toISOString(), next_step: "Resolve the remaining blocker", working_directory: repo });
  const handoff = store.saveHandoff({ id: "handoff_session_partial_resume", project: session.project, task_id: session.id, content: "Partial work requires continuation", packet: {
    objective: session.goal, summary: "Partial work requires continuation", status: "completed", next_step: session.next_step,
    completed_steps: ["Completed the initial investigation"], decisions: [], acceptance_criteria: ["Finish the remaining work"],
    evidence: [{ type: "test", label: "fixture", status: "passed", observed_at: new Date().toISOString() }],
    provenance: { working_directory: repo, commit_sha: git("rev-parse", "HEAD"), branch: git("branch", "--show-current") },
  } });
  store.transitionHandoff(handoff.id, "completed");
  store.getDb().exec("CREATE TEMP TRIGGER reject_resumed_checkpoint BEFORE INSERT ON memory_handoff_events WHEN NEW.event_type = 'checkpoint_captured' BEGIN SELECT RAISE(ABORT, 'injected resumed checkpoint failure'); END");
  try {
    const interrupted = await invokeSession({ action: "resume", id: session.id });
    assert.equal(interrupted.isError, true, "checkpoint failure must not be reported as a successful resume");
    assert.equal(store.getTaskSession(session.id).state, "completed", "session must remain completed until its resumed checkpoint is verified");
  } finally { store.getDb().exec("DROP TRIGGER reject_resumed_checkpoint"); }
  const pending = store.getHandoffByTaskId(session.id);
  assert.equal(pending.lifecycle_state, "draft", "an interrupted checkpoint remains visibly non-authoritative");
  const result = await invokeSession({ action: "resume", id: session.id });
  assert.equal(result.isError, undefined);
  const resumed = store.getTaskSession(session.id);
  assert.equal(resumed.state, "active");
  assert.equal(resumed.ended_at, null, "resume must clear the persisted terminal timestamp");
  assert.equal(JSON.parse(result.content[0].text).session.ended_at, null);
  const linked = store.getHandoffByTaskId(session.id);
  assert.ok(["active", "ready"].includes(linked.lifecycle_state), "an active session must not point only to a terminal handoff");
  assert.equal(linked.id, pending.id, "retry must complete the same resumable checkpoint rather than creating a duplicate");
  assert.equal(store.getDb().prepare("SELECT COUNT(*) AS count FROM memory_handoffs WHERE task_id = ?").get(session.id).count, 2, "the completed source and one resumed checkpoint are retained");

  const completed = await invokeSession({ action: "end", id: session.id, outcome: "partial", acceptance_state: "blocked", final_summary: "A remaining blocker prevents completion." });
  assert.equal(completed.isError, undefined);
  const secondResume = await invokeSession({ action: "resume", id: session.id });
  assert.equal(secondResume.isError, undefined);
  const secondHandoff = store.getHandoffByTaskId(session.id);
  assert.ok(["active", "ready"].includes(secondHandoff.lifecycle_state));
  assert.notEqual(secondHandoff.id, linked.id, "a later partial-resume cycle creates a new append-only checkpoint");
  assert.equal(secondHandoff.previous_id, linked.id);
  assert.equal(store.getDb().prepare("SELECT COUNT(*) AS count FROM memory_handoffs WHERE task_id = ?").get(session.id).count, 3);
});

test("legacy link repair during handoff lookup is atomic", () => {
  const db = store.getDb();
  const handoff = store.saveHandoff({
    project: "continuity",
    content: "Legacy record whose derived links need repair",
    packet: {
      objective: "Check lookup link repair",
      evidence: [{ type: "test", label: "legacy evidence" }],
      artifacts: [{ type: "fixture", ref: "artifact-1" }],
    },
  });
  db.prepare("DELETE FROM memory_handoff_links WHERE handoff_id = ? AND version = ?").run(handoff.id, handoff.version);
  db.exec("CREATE TEMP TRIGGER reject_artifact_link BEFORE INSERT ON memory_handoff_links WHEN NEW.link_type = 'artifact' BEGIN SELECT RAISE(ABORT, 'injected derived-link failure'); END");
  try {
    assert.throws(() => store.getHandoff(handoff.id), /injected derived-link failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_handoff_links WHERE handoff_id = ? AND version = ?").get(handoff.id, handoff.version).count, 0,
      "failed repair must not persist only the earlier evidence link");
  } finally { db.exec("DROP TRIGGER reject_artifact_link"); }

  store.getHandoff(handoff.id);
  const repaired = store.getHandoff(handoff.id);
  assert.deepEqual(repaired.links.map(link => link.type).sort(), ["artifact", "evidence"]);
});

test("metadata-only handoff save rolls back when legacy link repair fails", () => {
  const original = create();
  const db = store.getDb();
  db.prepare("DELETE FROM memory_handoff_links WHERE handoff_id = ? AND version = ?").run(original.id, original.version);
  db.exec("CREATE TEMP TRIGGER reject_metadata_link BEFORE INSERT ON memory_handoff_links WHEN NEW.handoff_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected metadata link repair failure'); END");
  try {
    assert.throws(() => store.saveHandoff({
      id: original.id,
      title: "Title that must roll back",
      content: original.content,
      expectedVersion: original.version,
    }), /injected metadata link repair failure/);
    const row = db.prepare("SELECT title, version FROM memory_handoffs WHERE id = ?").get(original.id);
    assert.equal(row.title, original.title, "failed metadata save must preserve the original title");
    assert.equal(row.version, original.version, "metadata-only save must not create a version");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_handoff_links WHERE handoff_id = ? AND version = ?").get(original.id, original.version).count, 0);
  } finally { db.exec("DROP TRIGGER reject_metadata_link"); }

  const retried = store.saveHandoff({ id: original.id, title: "Metadata retry succeeded", content: original.content, expectedVersion: original.version });
  assert.equal(retried.title, "Metadata retry succeeded");
  assert.equal(retried.version, original.version);
  store.getHandoff(original.id);
  assert.equal(store.getHandoff(original.id).links.filter(link => link.type === "evidence").length, 1);
});

test("metadata-only handoff save rejects a concurrent version advance", () => {
  const original = create();
  const db = store.getDb();
  const originalPrepare = db.prepare;
  const prepare = db.prepare.bind(db);
  let advanced = false;
  db.prepare = function (sql) {
    const statement = prepare(sql);
    if (advanced || !String(sql).startsWith("SELECT * FROM memory_handoffs WHERE id = ?")) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "get") return (...args) => {
          const row = target.get(...args);
          if (!advanced && row?.id === original.id) {
            advanced = true;
            store.saveHandoff({
              id: original.id,
              project: original.project,
              content: "Decision: another writer advanced this handoff.",
              packet: { ...original.packet, next_step: "Reconcile the concurrent update" },
              expectedVersion: original.version,
            });
          }
          return row;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  try {
    assert.throws(() => store.saveHandoff({
      id: original.id,
      title: "Stale metadata title",
      content: original.content,
      expectedVersion: original.version,
    }), /changed concurrently during metadata save/);
  } finally { db.prepare = originalPrepare; }

  assert.equal(advanced, true);
  const current = store.getHandoff(original.id);
  assert.equal(current.version, original.version + 1);
  assert.equal(current.title, original.title, "the stale metadata write must not apply to the newer version");
  assert.equal(current.content, "Decision: another writer advanced this handoff.");
});

test("evidence refresh state rolls back when its journal event fails", () => {
  const handoff = create();
  const db = store.getDb();
  db.exec("CREATE TEMP TRIGGER reject_evidence_refresh BEFORE INSERT ON memory_handoff_events WHEN NEW.event_type = 'evidence_refreshed' BEGIN SELECT RAISE(ABORT, 'injected evidence journal failure'); END");
  try {
    assert.throws(() => store.refreshHandoffEvidence(handoff.id, { working_directory: repo }), /injected evidence journal failure/);
    assert.deepEqual(store.getHandoffEvidenceState(handoff.id), [], "a failed refresh must not leave new authoritative evidence state");
    assert.equal(store.listHandoffEvents(handoff.id).filter(event => event.event_type === "evidence_refreshed").length, 0);
  } finally { db.exec("DROP TRIGGER reject_evidence_refresh"); }

  assert.equal(store.refreshHandoffEvidence(handoff.id, { working_directory: repo }).status, "refreshed");
  assert.equal(store.getHandoffEvidenceState(handoff.id).length, 1);
  assert.equal(store.listHandoffEvents(handoff.id).filter(event => event.event_type === "evidence_refreshed").length, 1);
});

test("stale handoff snapshots cannot extract memories or mark a newer version processed", () => {
  const stale = create();
  const latest = store.saveHandoff({
    id: stale.id,
    project: stale.project,
    content: "Decision: use the latest checkpoint as the source of truth.",
    packet: { ...stale.packet, next_step: "Verify the current checkpoint" },
    expectedVersion: stale.version,
  });

  assert.throws(() => extractHandoffMemories(stale), /changed since it was read/);
  assert.equal(store.getHandoff(latest.id).extraction_state, "pending");
  assert.equal(store.getDb().prepare("SELECT COUNT(*) AS count FROM memories WHERE source_ref = ?").get(latest.id).count, 0,
    "a stale packet must not create derived memories");

  const extracted = extractHandoffMemories(store.getHandoff(latest.id));
  assert.ok(extracted.some(memory => memory.content === "use the latest checkpoint as the source of truth."));
  assert.equal(store.getHandoff(latest.id).extraction_state, "processed");
  const count = store.getDb().prepare("SELECT COUNT(*) AS count FROM memories WHERE source_ref = ?").get(latest.id).count;
  assert.throws(() => extractHandoffMemories(store.getHandoff(latest.id), { project: "other_project" }), /does not match the requested extraction scope/);
  assert.equal(store.getDb().prepare("SELECT COUNT(*) AS count FROM memories WHERE source_ref = ?").get(latest.id).count, count,
    "a mismatched project override must not create cross-project derived memories");
});

test("handoff memory extraction rolls back the whole derived set on failure", () => {
  const handoff = store.saveHandoff({
    project: "continuity",
    content: "Fact: First derived fact remains useful.\nDecision: Second derived fact completes the extraction.",
    packet: { objective: "Test extraction rollback", status: "active", next_step: "Retry extraction" },
  });
  const db = store.getDb();
  db.exec(`CREATE TEMP TRIGGER reject_second_extracted_memory BEFORE INSERT ON memories
    WHEN NEW.source_ref = '${handoff.id}' AND NEW.content = 'Second derived fact completes the extraction.'
    BEGIN SELECT RAISE(ABORT, 'injected extraction failure'); END`);
  try {
    assert.throws(() => extractHandoffMemories(handoff), /injected extraction failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE source_ref = ?").get(handoff.id).count, 0,
      "a failed extraction must not leave a prefix of its derived memories");
    assert.equal(store.getHandoff(handoff.id).extraction_state, "pending");
  } finally { db.exec("DROP TRIGGER reject_second_extracted_memory"); }

  assert.equal(extractHandoffMemories(store.getHandoff(handoff.id)).length, 2);
  assert.equal(store.getHandoff(handoff.id).extraction_state, "processed");
});

test("purging handoff history rolls back deletion when its audit write fails", () => {
  const db = store.getDb();
  const first = create();
  store.saveHandoff({
    id: first.id,
    project: first.project,
    content: "Second version retained for purge audit fixture",
    packet: { ...first.packet, next_step: "Finish the purge audit fixture" },
    expectedVersion: first.version,
  });
  const original = store.getHandoffVersion(first.id, first.version);
  db.exec("CREATE TEMP TRIGGER reject_purge_audit BEFORE INSERT ON memory_audit_events WHEN NEW.event_type = 'handoff_version_purged' BEGIN SELECT RAISE(ABORT, 'injected purge audit failure'); END");
  try {
    assert.throws(() => store.purgeHandoffVersion(first.id, first.version, { reason: "isolated atomicity fixture", source: "test" }), /injected purge audit failure/);
    assert.deepEqual(store.getHandoffVersion(first.id, first.version), original, "an audit failure must preserve the historical content and links");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_audit_events WHERE event_type = 'handoff_version_purged' AND target_id = ?").get(first.id).count, 0);
  } finally { db.exec("DROP TRIGGER reject_purge_audit"); }

  db.exec("CREATE TEMP TRIGGER ignore_purge_audit BEFORE INSERT ON memory_audit_events WHEN NEW.event_type = 'handoff_version_purged' BEGIN SELECT RAISE(IGNORE); END");
  try {
    assert.throws(() => store.purgeHandoffVersion(first.id, first.version, { reason: "isolated atomicity fixture", source: "test" }), /audit event .* was not persisted/i);
    assert.deepEqual(store.getHandoffVersion(first.id, first.version), original, "a silently ignored audit insert must also preserve history");
  } finally { db.exec("DROP TRIGGER ignore_purge_audit"); }

  const result = store.purgeHandoffVersion(first.id, first.version, { reason: "isolated atomicity fixture", source: "test" });
  assert.equal(result.purged, true);
  assert.equal(store.getHandoffVersion(first.id, first.version), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_audit_events WHERE event_type = 'handoff_version_purged' AND target_id = ?").get(first.id).count, 1);
});

test("archive rolls back its state change when audit persistence fails", () => {
  const db = store.getDb();
  const h = create();
  db.exec("CREATE TEMP TRIGGER reject_handoff_archive BEFORE INSERT ON memory_audit_events WHEN NEW.event_type = 'handoff_archived' BEGIN SELECT RAISE(ABORT, 'injected archive audit failure'); END");
  try {
    assert.throws(() => store.archiveHandoff(h.id, "isolated archive audit fixture"), /injected archive audit failure/);
    assert.equal(store.getHandoff(h.id).archived_at, null, "failed archive must leave the handoff visible");
  } finally { db.exec("DROP TRIGGER reject_handoff_archive"); }
  assert.equal(store.archiveHandoff(h.id, "isolated archive audit fixture"), true);
  assert.ok(store.getHandoff(h.id).archived_at);
});

test("unarchive rolls back its state change when audit persistence fails", () => {
  const db = store.getDb();
  const h = create();
  assert.equal(store.archiveHandoff(h.id, "isolated unarchive audit fixture"), true);
  const archivedAt = store.getHandoff(h.id).archived_at;
  db.exec("CREATE TEMP TRIGGER reject_handoff_unarchive BEFORE INSERT ON memory_audit_events WHEN NEW.event_type = 'handoff_unarchived' BEGIN SELECT RAISE(ABORT, 'injected unarchive audit failure'); END");
  try {
    assert.throws(() => store.unarchiveHandoff(h.id), /injected unarchive audit failure/);
    assert.equal(store.getHandoff(h.id).archived_at, archivedAt, "failed unarchive must preserve the archived state");
  } finally { db.exec("DROP TRIGGER reject_handoff_unarchive"); }
  assert.equal(store.unarchiveHandoff(h.id), true);
  assert.equal(store.getHandoff(h.id).archived_at, null);
});

test("restoring a handoff version rolls back if its restore audit fails", () => {
  const db = store.getDb();
  const h = create();
  store.saveHandoff({
    id: h.id,
    project: h.project,
    content: "Current version before restore audit fixture",
    packet: { ...h.packet, next_step: "Restore should remain pending" },
    expectedVersion: h.version,
  });
  const before = store.getHandoff(h.id);
  const historyBefore = store.listHandoffVersions(h.id);
  db.exec("CREATE TEMP TRIGGER reject_handoff_restore BEFORE INSERT ON memory_audit_events WHEN NEW.event_type = 'handoff_restored' BEGIN SELECT RAISE(ABORT, 'injected restore audit failure'); END");
  try {
    assert.throws(() => store.restoreHandoffVersion(h.id, h.version, { source: "test" }), /injected restore audit failure/);
    assert.deepEqual(store.getHandoff(h.id), before, "failed restore must not advance current content or version");
    assert.deepEqual(store.listHandoffVersions(h.id), historyBefore, "failed restore must not append an unrecorded version");
  } finally { db.exec("DROP TRIGGER reject_handoff_restore"); }
  const restored = store.restoreHandoffVersion(h.id, h.version, { source: "test" });
  assert.equal(restored.handoff.version, before.version + 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_audit_events WHERE event_type = 'handoff_restored' AND target_id = ?").get(h.id).count, 1);
});

test("persisted fresh evidence expires before a receiver resumes", () => {
  const h = ready();
  assert.equal(store.getHandoffResumePreflight(h.id).safe_to_resume, true);
  const now = Date.now;
  Date.now = () => now() + 8 * 24 * 60 * 60 * 1000;
  try {
    const result = store.getHandoffResumePreflight(h.id);
    assert.equal(result.safe_to_resume, false, "cached verification cannot stay fresh forever");
    assert.ok(result.projection.evidence.stale > 0);
  } finally { Date.now = now; }
});

test("future-dated evidence cannot establish receiver readiness", () => {
  const h = ready([{ type: "test", status: "passed", observed_at: new Date(Date.now() + 86400000).toISOString() }]);
  assert.equal(store.getHandoffResumePreflight(h.id).safe_to_resume, false);
});

test("resume check blocks a persisted link whose project no longer matches", async () => {
  const h = create();
  store.setDocument("resume", { items: { other_project: { project: "other_project", status: "active", handoff_id: h.id, summary: "Fixture pointer" } } });
  const result = await invokeResume({ action: "check", project: "other_project", format: "json" });
  const item = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true);
  assert.equal(item.resume_blocked, true);
  assert.equal(item.handoff_validation.valid, false);
});

test("cross-project completion cannot silently clear a pending resume pointer", async () => {
  const h = create();
  store.transitionHandoff(h.id, "completed");
  store.setDocument("resume", { items: { other_project: { project: "other_project", status: "active", handoff_id: h.id } } });
  const result = await invokeResume({ action: "check", project: "other_project", format: "json" });
  assert.equal(result.isError, true);
  assert.equal(store.loadDocument("resume").items.other_project.status, "active");
});

test("same-status tracked edits require reconciliation", () => {
  const file = path.join(repo, "tracked.txt");
  fs.writeFileSync(file, "first edit\n");
  const h = ready();
  const status = git("status", "--porcelain=v1");
  fs.writeFileSync(file, "second edit\n");
  assert.equal(git("status", "--porcelain=v1"), status);
  try { assert.notEqual(store.getHandoffReadiness(h.id).status, "ready"); }
  finally { fs.writeFileSync(file, "initial\n"); }
});

test("same-status untracked edits cannot appear verified", () => {
  const file = path.join(repo, "untracked.txt");
  fs.writeFileSync(file, "first draft\n");
  const h = ready();
  fs.writeFileSync(file, "second draft\n");
  try { assert.notEqual(store.getHandoffReadiness(h.id).status, "ready"); }
  finally { fs.unlinkSync(file); }
});

test("a fresh receiver recovers persisted objectives and decisions without conversation history", () => {
  const h = ready();
  const script = `const s=require('./src/db'); const d=require('./src/tools/dispatcher'); const c=require('./test/helpers/authorized-context').createOwnerContext({source:'internal'}); d.callInternalTool('handoff',{action:'start_here',id:process.argv[1],project:'continuity'},c).then(r=>{console.log(r.content[0].text);s.closeDatabase();});`;
  const output = execFileSync(process.execPath, ["-e", script, h.id], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: process.env });
  const result = JSON.parse(output);
  assert.equal(result.projection.start_here.objective, "Continue the fixture task");
  assert.deepEqual(result.projection.start_here.decisions, ["Retain existing storage"]);
  assert.equal(result.projection.start_here.next_step, "Finish the remaining assertion");
});

test("an independent receiver discovers by project, reconciles, and verifies a safe continuation", () => {
  const receiverProject = "continuity-independent-receiver";
  const receiverRepo = path.join(root, "receiver-repo");
  fs.mkdirSync(receiverRepo);
  const receiverGit = (...args) => execFileSync("git", ["-C", receiverRepo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  receiverGit("init");
  fs.writeFileSync(path.join(receiverRepo, "tracked.txt"), "initial\n");
  receiverGit("add", "tracked.txt");
  execFileSync("git", ["-C", receiverRepo, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "receiver fixture"], { stdio: "ignore" });
  const h = ready(undefined, { project: receiverProject, working_directory: receiverRepo });
  const workFile = path.join(receiverRepo, "tracked.txt");
  const script = `
    const s = require('./src/db');
    const { callInternalTool } = require('./src/tools/dispatcher');
    const context = require('./test/helpers/authorized-context').createOwnerContext({ source: 'internal' });
    const parse = async args => {
      const result = await callInternalTool('handoff', args, context);
      if (result.isError) throw new Error(result.content?.[0]?.text || 'handoff operation failed');
      return JSON.parse(result.content[0].text);
    };
    (async () => {
      try {
        // The receiver starts with only the canonical project identity. It
        // does not receive the source process's handoff ID or conversation.
        const listed = await parse({ action: 'list', project: ${JSON.stringify(receiverProject)} });
        const discovered = listed.handoffs.find(item => item.project === ${JSON.stringify(receiverProject)} && item.lifecycle_state === 'ready');
        if (!discovered) throw new Error('no ready handoff found for project');
        const start = await parse({ action: 'start_here', id: discovered.id, project: ${JSON.stringify(receiverProject)}, working_directory: ${JSON.stringify(receiverRepo)} });
        if (start.projection.readiness.status !== 'ready') throw new Error('checkpoint needs reconciliation before continuation');
        if (start.projection.start_here.objective !== 'Continue the fixture task') throw new Error('objective did not recover');
        if (!start.projection.start_here.next_step) throw new Error('next action did not recover');
        // This deterministic harness owns the fixture action. It never treats
        // retrieved handoff text as executable instructions.
        require('node:fs').writeFileSync(${JSON.stringify(workFile)}, 'receiver-completed\\n');
        const refreshed = await parse({ action: 'checkpoint', id: discovered.id, project: ${JSON.stringify(receiverProject)}, working_directory: ${JSON.stringify(receiverRepo)} });
        const readiness = await parse({ action: 'readiness', id: discovered.id, project: ${JSON.stringify(receiverProject)}, working_directory: ${JSON.stringify(receiverRepo)} });
        process.stdout.write(JSON.stringify({ id: discovered.id, objective: start.projection.start_here.objective, decisions: start.projection.start_here.decisions, next_step: start.projection.start_here.next_step, readiness: readiness.readiness.status, readiness_reasons: readiness.readiness.reasons, checkpoint_hash: refreshed.handoff.checkpoint_hash, completed_fixture_action: require('node:fs').readFileSync(${JSON.stringify(workFile)}, 'utf8') }));
      } finally { s.closeDatabase(); }
    })().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: process.env });
  const result = JSON.parse(output);
  assert.equal(result.id, h.id);
  assert.equal(result.objective, "Continue the fixture task");
  assert.deepEqual(result.decisions, ["Retain existing storage"]);
  assert.equal(result.next_step, "Finish the remaining assertion");
  assert.equal(result.completed_fixture_action, "receiver-completed\n");
  assert.ok(result.checkpoint_hash, "receiver must persist its reconciled checkpoint");
  assert.equal(result.readiness, "ready", `receiver must verify repository state after its continuation: ${JSON.stringify(result.readiness_reasons)}`);
});

test("changing staged contents with the same status is detected", () => {
  const file = path.join(repo, "tracked.txt");
  fs.writeFileSync(file, "stage one\n");
  git("add", "tracked.txt");
  const h = ready();
  const status = git("status", "--porcelain=v1");
  fs.writeFileSync(file, "stage two\n");
  git("add", "tracked.txt");
  try {
    assert.equal(git("status", "--porcelain=v1"), status);
    assert.equal(store.getHandoffReadiness(h.id).status, "reconciliation_required");
  } finally {
    fs.writeFileSync(file, "initial\n");
    git("add", "tracked.txt");
  }
});

test("missing refreshed evidence rows fail closed without dropping packet evidence", () => {
  const stamp = new Date().toISOString();
  const h = ready([{ type: "test", status: "passed", observed_at: stamp }, { type: "test", status: "passed", observed_at: stamp }]);
  store.getDb().prepare("DELETE FROM memory_handoff_evidence_state WHERE handoff_id = ? AND evidence_index = 1").run(h.id);
  const result = store.getHandoffResumePreflight(h.id);
  assert.equal(result.safe_to_resume, false);
  assert.equal(result.projection.evidence.items.length, 2);
  assert.equal(result.projection.evidence.unknown, 1);
});

test("a stored invalid evidence result is not promoted by a recent timestamp", () => {
  const h = ready();
  store.getDb().prepare("UPDATE memory_handoff_evidence_state SET state = 'invalid' WHERE handoff_id = ?").run(h.id);
  const result = store.getHandoffResumePreflight(h.id);
  assert.equal(result.safe_to_resume, false);
  assert.equal(result.projection.evidence.invalid, 1);
});

test("legacy dirty checkpoint is readable but requires recapture", () => {
  const file = path.join(repo, "tracked.txt");
  fs.writeFileSync(file, "legacy edit\n");
  const h = ready();
  const checkpoint = store.getHandoff(h.id).checkpoint;
  delete checkpoint.repository.content_fingerprint;
  store.getDb().prepare("UPDATE memory_handoffs SET checkpoint_json = ?, checkpoint_hash = NULL WHERE id = ?").run(JSON.stringify(checkpoint), h.id);
  try {
    assert.ok(store.getHandoff(h.id).checkpoint);
    const result = store.getHandoffReadiness(h.id);
    assert.equal(result.status, "blocked");
    assert.ok(result.reasons.some(reason => reason.includes("legacy dirty checkpoint")));
    store.captureHandoffCheckpoint(h.id, { working_directory: repo });
    assert.equal(store.getHandoffReadiness(h.id).status, "ready");
  } finally { fs.writeFileSync(file, "initial\n"); }
});

test("concurrent resume updates for different projects do not overwrite each other", async () => {
  const barrier = path.join(root, "resume-race");
  fs.mkdirSync(barrier);
  const script = `
    const fs = require('node:fs');
    const s = require('./src/db');
    require('./src/tools/context').setExecutionSource('test');
    const original = s.loadDocument;
    let paused = false;
    s.loadDocument = (name, fallback) => {
      const doc = original(name, fallback);
      if (name === 'resume' && !paused) {
        paused = true;
        fs.writeFileSync(process.argv[1], 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const until = Date.now() + 15000;
        while (!fs.existsSync(process.argv[2]) && Date.now() < until) Atomics.wait(wait, 0, 0, 10);
        if (!fs.existsSync(process.argv[2])) throw new Error('resume race barrier timed out');
      }
      return doc;
    };
    const resume = require('./src/tools/families/resume');
    const { dispatchTestTool } = require('./src/tools/dispatcher');
    const descriptor = resume.descriptors.find(item => item.name === 'resume');
    dispatchTestTool({ descriptor, args: { action: 'set', project: process.argv[3], summary: 'independent concurrent fixture', next_step: 'verify retained pointer' }, context: { source: 'test' } })
      .then(result => { if (result.isError) throw new Error(result.content?.[0]?.text || 'resume set failed'); process.stdout.write('saved'); })
      .catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; })
      .finally(() => s.closeDatabase());
  `;
  const projects = ["resume_race_alpha", "resume_race_beta"];
  const children = projects.map((project, index) => {
    const readyFile = path.join(barrier, `${index}.ready`);
    const releaseFile = path.join(barrier, `${index}.release`);
    const child = spawn(process.execPath, ["-e", script, readyFile, releaseFile, project], {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(`resume writer ${project} exited ${code}: ${stderr}`)));
    });
    return { readyFile, releaseFile, closed };
  });

  const deadline = Date.now() + 15000;
  while (children.some(child => !fs.existsSync(child.readyFile)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  for (const child of children) fs.writeFileSync(child.releaseFile, "go");
  const outcomes = await Promise.allSettled(children.map(child => child.closed));
  assert.ok(children.every(child => fs.existsSync(child.readyFile)), "both processes must observe the same pre-write document");
  assert.ok(outcomes.every(outcome => outcome.status === "fulfilled"), outcomes.filter(outcome => outcome.status === "rejected").map(outcome => String(outcome.reason)).join("\n"));
  const outputs = outcomes.map(outcome => outcome.value);
  assert.deepEqual(outputs, ["saved", "saved"]);
  const items = store.loadDocument("resume", { items: {} }).items;
  assert.ok(items.resume_race_alpha, "first project resume pointer must survive the competing update");
  assert.ok(items.resume_race_beta, "second project resume pointer must survive the competing update");
});

test("handoff list stays within trusted project scope across MCP dispatch", async () => {
  const principal = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Handoff scope fixture" });
  identity.assignRole(principal.principal_id, "operator", resumeOwner);
  for (const project of ["continuity", "other_project"]) {
    store.saveHandoff({
      project,
      content: `Scoped handoff for ${project}`,
      owner_principal_id: principal.principal_id,
      created_by_principal_id: principal.principal_id,
    });
  }
  const bound = await callMcpTool("handoff", { action: "list" }, {
    project: "continuity",
    authIdentity: { principal_id: principal.principal_id },
  });
  assert.notEqual(bound.isError, true, bound.content?.[0]?.text);
  const visible = JSON.parse(bound.content[0].text).handoffs;
  assert.ok(visible.length > 0);
  assert.ok(visible.every(item => item.project === "continuity"), "a bound project must scope list results even when args omit project");

  const override = await callMcpTool("handoff", { action: "list", project: "other_project" }, {
    project: "continuity",
    authIdentity: { principal_id: principal.principal_id },
  });
  assert.equal(override.isError, true, "explicit project arguments cannot broaden a trusted execution scope");
});

test("resume list inherits trusted project scope across MCP dispatch", async () => {
  const principal = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Resume scope fixture" });
  identity.assignRole(principal.principal_id, "operator", resumeOwner);
  grantResumeRead(principal.principal_id, "continuity");
  store.setDocument("resume", { items: {
    continuity: { project: "continuity", status: "active", summary: "Visible scoped item", next_step: "Continue safely" },
    other_project: { project: "other_project", status: "active", summary: "Must remain private to its scope", next_step: "Do not expose" },
  } });
  const result = await callMcpTool("resume", { action: "list", format: "json" }, {
    project: "continuity",
    authIdentity: { principal_id: principal.principal_id },
  });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const visible = JSON.parse(result.content[0].text).items;
  assert.ok(visible.length > 0);
  assert.ok(visible.every(item => item.project === "continuity"), "a bound project must constrain resume list results");
});

test("resume mutations cannot override a trusted project scope", async () => {
  const principal = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Resume mutation scope fixture" });
  identity.assignRole(principal.principal_id, "operator", resumeOwner);
  store.setDocument("resume", { items: {
    continuity: { project: "continuity", status: "active", summary: "Scoped item", next_step: "Continue" },
    other_project: { project: "other_project", status: "active", summary: "Original foreign summary", next_step: "Original next step" },
  } });
  const result = await callMcpTool("resume", { action: "set", project: "other_project", summary: "Override", next_step: "Must be rejected" }, {
    project: "continuity",
    authIdentity: { principal_id: principal.principal_id },
  });
  assert.equal(result.isError, true, "explicit project arguments cannot override a trusted execution scope");
  assert.equal(store.loadDocument("resume").items.other_project.summary, "Original foreign summary");
});

test("scoped resume reads do not synchronize foreign project pointers", async () => {
  const principal = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Resume sync scope fixture" });
  identity.assignRole(principal.principal_id, "operator", resumeOwner);
  grantResumeRead(principal.principal_id, "continuity");
  const foreignHandoff = create(undefined, { project: "other_project" });
  store.transitionHandoff(foreignHandoff.id, "completed");
  store.setDocument("resume", { items: {
    continuity: { project: "continuity", status: "active", summary: "Visible item", next_step: "Continue" },
    other_project: { project: "other_project", status: "active", summary: "Foreign item", next_step: "Continue", handoff_id: foreignHandoff.id },
  } });
  const result = await callMcpTool("resume", { action: "list", format: "json" }, {
    project: "continuity",
    authIdentity: { principal_id: principal.principal_id },
  });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.equal(store.loadDocument("resume").items.other_project.status, "active", "scoped reads must not mutate foreign project state");
});
