"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("../src/agent-history");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-agent-history-"));
function id(n) { return n.toString(16).padStart(8, "0"); }
function write(name, record) { fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(record)); }

try {
  // Deliberately make lexical filename order unrelated to actual chronology.
  for (let i = 0; i < 25; i++) write(id(255 - i), { goal: "goal " + i, status: "completed", t: new Date(Date.UTC(2026, 7, 22, 12, i)).toISOString(), result: "answer " + i, steps: [] });
  write("abcdef01", { goal: "root", status: "completed", t: "2026-08-22T13:00:00.000Z", root_task_id: "abcdef01", continuation_depth: 0, steps: [] });
  write("abcdef02", { goal: "follow-up", status: "failed", t: "2026-08-22T13:01:00.000Z", root_task_id: "abcdef01", parent_task_id: "abcdef01", continuation_depth: 1, error: "nope", steps: [] });
  write("abcdef03", { goal: "second follow-up", status: "iteration_limit", t: "2026-08-22T13:02:00.000Z", root_task_id: "abcdef01", parent_task_id: "abcdef02", continuation_depth: 2, work_state: { objective: "secret internal state", evidence: [{ reference: "e1" }], tool_calls: 4, iterations: 7 }, steps: [{ type: "thought", text: "private reasoning" }, { type: "step", text: "safe progress" }] });
  fs.writeFileSync(path.join(dir, "badbad01.json"), "{not json");
  write("abcdef04", { goal: "legacy fallback", status: "completed", t: "not-a-date", steps: [] });
  fs.utimesSync(path.join(dir, "abcdef04.json"), new Date(0), new Date(0));

  const first = H.assembleSessions(dir, { pageSize: 1 });
  assert.strictEqual(first.sessions.length, 1);
  assert.strictEqual(first.sessions[0].goal, "root");
  assert.ok(first.nextOffset, "pagination exposes a next offset");
  const all = H.assembleSessions(dir, { pageSize: 50 });
  assert.ok(all.total > 20, "history is not silently capped at twenty records/sessions");
  assert.ok(all.malformed >= 1, "malformed records are isolated and observable");
  assert.strictEqual(all.sessions[0].lastActivityAt, "2026-08-22T13:02:00.000Z");

  const session = H.buildSession(dir, "abcdef01");
  assert.strictEqual(session.turnCount, 3);
  assert.deepStrictEqual(session.turns.map(t => t.id), ["abcdef01", "abcdef02", "abcdef03"]);
  assert.strictEqual(session.latestTaskId, "abcdef03");
  assert.strictEqual(session.turns[2].workState.evidence_count, 1);
  assert.strictEqual(session.turns[2].workState.objective, "secret internal state".slice(0, 400));
  assert.ok(!session.turns[2].steps.some(step => step.text === "private reasoning"), "hidden reasoning is excluded from session DTO");
  assert.strictEqual(H.buildSession(dir, "../bad"), null);
  assert.strictEqual(H.buildTask(dir, "badbad01"), null);
  console.log("Agent history tests passed.");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
