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
const { sidekick_resume } = require("../src/tools/families/resume");
const { callMcpTool } = require("../src/tools/dispatcher");
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
    assert.throws(() => store.purgeHandoffVersion(first.id, first.version, { reason: "isolated atomicity fixture", source: "test" }), /audit event was not persisted/);
    assert.deepEqual(store.getHandoffVersion(first.id, first.version), original, "a silently ignored audit insert must also preserve history");
  } finally { db.exec("DROP TRIGGER ignore_purge_audit"); }

  const result = store.purgeHandoffVersion(first.id, first.version, { reason: "isolated atomicity fixture", source: "test" });
  assert.equal(result.purged, true);
  assert.equal(store.getHandoffVersion(first.id, first.version), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_audit_events WHERE event_type = 'handoff_version_purged' AND target_id = ?").get(first.id).count, 1);
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
    const { sidekick_handoff } = require('./src/tools/families/memory-handoff');
    const parse = async args => {
      const result = await sidekick_handoff(args);
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
    const { sidekick_resume } = require('./src/tools/families/resume');
    sidekick_resume({ action: 'set', project: process.argv[3], summary: 'independent concurrent fixture', next_step: 'verify retained pointer' })
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
  const principal = identity.createPrincipal({ type: "service", displayName: "Handoff scope fixture" });
  identity.assignRole(principal.principal_id, "operator");
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
  const principal = identity.createPrincipal({ type: "service", displayName: "Resume scope fixture" });
  identity.assignRole(principal.principal_id, "operator");
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
  const principal = identity.createPrincipal({ type: "service", displayName: "Resume mutation scope fixture" });
  identity.assignRole(principal.principal_id, "operator");
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
  const principal = identity.createPrincipal({ type: "service", displayName: "Resume sync scope fixture" });
  identity.assignRole(principal.principal_id, "operator");
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
