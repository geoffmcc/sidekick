"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-continuity-"));
process.env.SIDEKICK_DATA_DIR = path.join(root, "data");
process.env.SIDEKICK_DB_FILE = path.join(root, "data", "sidekick.db");
process.env.SIDEKICK_EMBEDDINGS = "0";
const store = require("../src/db");
const { sidekick_resume } = require("../src/tools/families/resume");
store.runPendingMigrations();
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
function create(evidence = [{ type: "test", label: "fixture assertion", status: "passed", observed_at: new Date().toISOString() }]) {
  return store.saveHandoff({ project: "continuity", content: `Decision: preserve verified work (fixture ${++sequence}).`, packet: {
    objective: "Continue the fixture task", status: "active", next_step: "Finish the remaining assertion",
    completed_steps: ["Initialized fixture"], decisions: ["Retain existing storage"],
    acceptance_criteria: ["Independent receiver sees persisted state"], evidence,
    provenance: { working_directory: repo, commit_sha: git("rev-parse", "HEAD"), branch: git("branch", "--show-current") },
  } });
}

function ready(evidence) {
  const h = create(evidence);
  store.captureHandoffCheckpoint(h.id, { working_directory: repo });
  store.transitionHandoff(h.id, "ready");
  store.refreshHandoffEvidence(h.id, { working_directory: repo });
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
  const result = await sidekick_resume({ action: "check", project: "other_project", format: "json" });
  const item = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true);
  assert.equal(item.resume_blocked, true);
  assert.equal(item.handoff_validation.valid, false);
});

test("cross-project completion cannot silently clear a pending resume pointer", async () => {
  const h = create();
  store.transitionHandoff(h.id, "completed");
  store.setDocument("resume", { items: { other_project: { project: "other_project", status: "active", handoff_id: h.id } } });
  const result = await sidekick_resume({ action: "check", project: "other_project", format: "json" });
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
  const script = `const s=require('./src/db'); const {sidekick_handoff}=require('./src/tools/families/memory-handoff'); sidekick_handoff({action:'start_here',id:process.argv[1],project:'continuity'}).then(r=>{console.log(r.content[0].text);s.closeDatabase();});`;
  const output = execFileSync(process.execPath, ["-e", script, h.id], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: process.env });
  const result = JSON.parse(output);
  assert.equal(result.projection.start_here.objective, "Continue the fixture task");
  assert.deepEqual(result.projection.start_here.decisions, ["Retain existing storage"]);
  assert.equal(result.projection.start_here.next_step, "Finish the remaining assertion");
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
