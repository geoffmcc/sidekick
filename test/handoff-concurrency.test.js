"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-handoff-races-"));
process.env.SIDEKICK_DATA_DIR = path.join(root, "data");
process.env.SIDEKICK_DB_FILE = path.join(root, "data", "sidekick.db");
process.env.SIDEKICK_EMBEDDINGS = "0";
const store = require("../src/db");
const { createHandoffStore } = require("../src/db/handoff-store");
const { childProcessEnv } = require("../src/security/child-process");
store.runPendingMigrations();
const db = store.getDb();
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
git("init");
fs.writeFileSync(path.join(repo, "task.txt"), "unfinished task\n");
git("add", "task.txt");
git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
const revision = git("rev-parse", "HEAD");

test.after(() => {
  store.closeDatabase();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

let sequence = 0;
function fixture(claimed = false) {
  const h = store.saveHandoff({ project: "race_fixture", content: `Decision: preserve competing work ${++sequence}.`, packet: {
    objective: "Finish the fixture task", status: "active", next_step: "Implement the remaining assertion",
    completed_steps: ["Recorded the initial repository"], decisions: ["Keep one authoritative store"],
    acceptance_criteria: ["No stale writer may replace newer continuity state"],
    evidence: [{ type: "test", status: "passed", observed_at: new Date().toISOString() }],
    provenance: { working_directory: repo, commit_sha: revision },
  } });
  store.captureHandoffCheckpoint(h.id);
  store.transitionHandoff(h.id, "ready");
  store.refreshHandoffEvidence(h.id);
  return claimed ? { ...h, ...store.claimHandoff(h.id, { owner: "receiver", leaseSeconds: 60 }) } : h;
}

function row(id) { return db.prepare("SELECT * FROM memory_handoffs WHERE id = ?").get(id); }
function events(id) { return store.listHandoffEvents(id); }

// Real second process and SQLite connection; synchronization at the injected
// Git boundary avoids scheduling sleeps and never touches a production DB.
function competitor(id, action) {
  const program = `const s=require('./src/db'); const id=process.argv[1]; ${action}; s.closeDatabase();`;
  execFileSync(process.execPath, ["-e", program, id], {
    cwd: path.resolve(__dirname, ".."), env: process.env, encoding: "utf8", timeout: 15000, stdio: "pipe",
  });
}

function interruptedStore(predicate, interrupt) {
  let fired = false;
  const stableHash = value => crypto.createHash("sha256").update(String(value || "")).digest("hex");
  const instance = createHandoffStore({ db, childProcessEnv,
    execFileSync(command, args, options) {
      const output = execFileSync(command, args, options);
      if (!fired && predicate(args)) { fired = true; interrupt(); }
      return output;
    },
    hasTable: name => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    nowIso: () => new Date(Date.now()).toISOString(),
    parseJson: (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } },
    stableHash, stableId: (prefix, value) => `${prefix}_${stableHash(value).slice(0, 20)}`,
    auditMemoryEvent() {},
  });
  return { instance, assertInterrupted: () => assert.equal(fired, true, "race must actually be exercised") };
}

for (const [event, claimed, mutate] of [
  ["lifecycle_changed", false, h => store.transitionHandoff(h.id, "active")],
  ["claimed", false, h => store.claimHandoff(h.id, { owner: "receiver" })],
  ["claim_renewed", true, h => store.renewHandoffClaim(h.id, { claim_token: h.claim_token, leaseSeconds: 120 })],
  ["resume_started", true, h => store.beginHandoffResume(h.id, { claim_token: h.claim_token })],
  ["released", true, h => store.releaseHandoff(h.id, { claim_token: h.claim_token })],
]) {
  test(`${event}: rejected journal insert rolls back state and permits a safe retry`, () => {
    const h = fixture(claimed), before = row(h.id), journal = events(h.id);
    db.exec(`CREATE TEMP TRIGGER reject_event BEFORE INSERT ON memory_handoff_events WHEN NEW.event_type = '${event}' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`);
    try {
      assert.throws(() => mutate(h), /injected journal failure/);
      assert.deepEqual(row(h.id), before, "failed operation must leave the complete handoff row unchanged");
      assert.deepEqual(events(h.id), journal);
    } finally { db.exec("DROP TRIGGER reject_event"); }
    mutate(h);
    assert.equal(events(h.id).length, journal.length + 1, "retry commits exactly one event");
  });
}

test("silently ignored journal writes cannot commit a checkpoint", () => {
  const h = fixture(), before = row(h.id);
  db.exec("CREATE TEMP TRIGGER ignore_event BEFORE INSERT ON memory_handoff_events WHEN NEW.event_type = 'checkpoint_captured' BEGIN SELECT RAISE(IGNORE); END");
  try {
    assert.throws(() => store.captureHandoffCheckpoint(h.id), /journal|event/i);
    assert.deepEqual(row(h.id), before);
  } finally { db.exec("DROP TRIGGER ignore_event"); }
});

test("a concurrent checkpoint wins without a packet version change", () => {
  const h = fixture();
  let winner;
  const racing = interruptedStore(() => true, () => {
    competitor(h.id, "s.captureHandoffCheckpoint(id, {metadata:{writer:'second'}})");
    winner = row(h.id);
  });
  assert.throws(() => racing.instance.captureHandoffCheckpoint(h.id, { expectedVersion: h.version }), /changed concurrently/);
  racing.assertInterrupted();
  assert.deepEqual(row(h.id), winner);
  assert.equal(events(h.id)[0].payload.metadata.writer, "second");
});

test("revocation during readiness observation cannot be overwritten by a claim", () => {
  const h = fixture();
  const racing = interruptedStore(() => true, () => competitor(h.id, "s.transitionHandoff(id,'revoked')"));
  assert.throws(() => racing.instance.claimHandoff(h.id, { owner: "late_receiver" }), /changed concurrently|not ready/);
  racing.assertInterrupted();
  assert.equal(store.getHandoff(h.id).lifecycle_state, "revoked");
  assert.equal(store.getHandoff(h.id).claim, null);
});

test("packet changes during preflight invalidate begin_resume", () => {
  const h = fixture(true);
  const racing = interruptedStore(args => args.includes("cat-file"), () => competitor(h.id,
    "const h=s.getHandoff(id); s.saveHandoff({...h, packet:{...h.packet,next_step:'Reconcile newly discovered failure'},expectedVersion:h.version})"));
  assert.throws(() => racing.instance.beginHandoffResume(h.id, { claim_token: h.claim_token }), /changed concurrently|changed before/);
  racing.assertInterrupted();
  assert.equal(store.getHandoff(h.id).lifecycle_state, "claimed");
  assert.equal(store.getHandoff(h.id).version, h.version + 1);
});

test("a lease that expires during preflight cannot start resumption", () => {
  const h = fixture(true), originalNow = Date.now;
  const racing = interruptedStore(args => args.includes("cat-file"), () => {
    Date.now = () => new Date(h.expires_at).getTime() + 1;
  });
  try {
    assert.throws(() => racing.instance.beginHandoffResume(h.id, { claim_token: h.claim_token }), /expired|changed before/);
    racing.assertInterrupted();
    assert.equal(store.getHandoff(h.id).lifecycle_state, "claimed");
  } finally { Date.now = originalNow; }
});

for (const terminal of ["revoked", "completed", "superseded"]) {
  test(`a retained claim token cannot reopen a ${terminal} handoff`, () => {
    const h = fixture(true);
    store.transitionHandoff(h.id, "active");
    store.transitionHandoff(h.id, terminal);
    assert.throws(() => store.releaseHandoff(h.id, { claim_token: h.claim_token }), /state|active claim/);
    assert.equal(store.getHandoff(h.id).lifecycle_state, terminal);
  });
}

test("the journal guard detects an intervening lifecycle change even when row state returns", () => {
  const h = fixture();
  const racing = interruptedStore(() => true, () => competitor(h.id,
    "s.transitionHandoff(id,'active'); s.transitionHandoff(id,'ready')"));
  assert.throws(() => racing.instance.captureHandoffCheckpoint(h.id), /changed concurrently/);
  racing.assertInterrupted();
  assert.equal(store.getHandoff(h.id).lifecycle_state, "ready");
  assert.equal(events(h.id).filter(event => event.event_type === "checkpoint_captured").length, 1);
});

for (const [event, claimed, operation] of [
  ["checkpoint_captured", false, "s.captureHandoffCheckpoint(id)"],
  ["resume_started", true, "s.beginHandoffResume(id, {claim_token: process.argv[2]})"],
]) {
  test(`process exit before ${event} persistence leaves no partial commit`, () => {
    const h = fixture(claimed), before = row(h.id), journal = events(h.id);
    // A synthetic claim credential is passed over stdin, never command-line
    // arguments or logs. The fixture process exits while SQLite is in-flight.
    const program = `const s=require('./src/db'); const fs=require('node:fs');
      const {id,token}=JSON.parse(fs.readFileSync(0,'utf8')); process.argv[2]=token;
      const db=s.getDb(); db.function('fixture_exit',()=>process.exit(73));
      db.exec("CREATE TEMP TRIGGER crash_event BEFORE INSERT ON memory_handoff_events WHEN NEW.event_type='${event}' BEGIN SELECT fixture_exit(); END");
      ${operation}; process.exit(74);`;
    assert.throws(() => execFileSync(process.execPath, ["-e", program], {
      cwd: path.resolve(__dirname, ".."), env: process.env, timeout: 15000,
      input: JSON.stringify({ id: h.id, token: h.claim_token }), stdio: ["pipe", "pipe", "pipe"],
    }), error => error.status === 73);
    assert.deepEqual(row(h.id), before, "SQLite rolls back the interrupted row update");
    assert.deepEqual(events(h.id), journal);
    if (claimed) store.beginHandoffResume(h.id, { claim_token: h.claim_token });
    else store.captureHandoffCheckpoint(h.id);
    assert.equal(events(h.id).length, journal.length + 1);
    assert.equal(store.getHandoffReadiness(h.id).journal.valid, true);
  });
}

test("continuity transactions compose with an outer caller transaction", () => {
  const h = fixture(), before = row(h.id), journal = events(h.id);
  assert.throws(() => db.transaction(() => {
    store.transitionHandoff(h.id, "active");
    throw new Error("caller aborted");
  })(), /caller aborted/);
  assert.deepEqual(row(h.id), before);
  assert.deepEqual(events(h.id), journal);
});
