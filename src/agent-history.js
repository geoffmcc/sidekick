"use strict";

// Read-only Agent session/history projection.  Transcripts remain the
// authoritative per-task records; this module only assembles bounded,
// presentation-safe summaries and chains.
const fs = require("fs");
const path = require("path");
const { CONTINUATION_LIMITS, validateTaskId, normalizeTranscript, resolveFinalAnswer } = require("./agent-continuation");

const HISTORY_LIMITS = Object.freeze({ DEFAULT_PAGE_SIZE: 20, MAX_PAGE_SIZE: 50, MAX_SCAN_FILES: 5000, MAX_SESSION_TURNS: 32 });

function parsePage(value, fallback, max) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function canonicalTime(record, stat) {
  const parsed = Date.parse(record && record.t);
  if (Number.isFinite(parsed)) return { ms: parsed, iso: new Date(parsed).toISOString(), source: "transcript" };
  const mtime = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : NaN;
  if (Number.isFinite(mtime)) return { ms: mtime, iso: new Date(mtime).toISOString(), source: "filesystem" };
  return { ms: 0, iso: null, source: "unavailable" };
}

function safeWorkProjection(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const evidence = Array.isArray(state.evidence) ? state.evidence.length : 0;
  const operations = Number.isInteger(state.tool_calls) ? state.tool_calls : null;
  return {
    phase: typeof state.stopping_condition === "string" && state.stopping_condition ? "verifying" : null,
    iteration: Number.isInteger(state.iterations) ? state.iterations : null,
    evidence_count: evidence,
    operation_count: operations,
    objective: typeof state.objective === "string" ? state.objective.slice(0, 400) : null,
  };
}

function loadEntries(convDir, deps = {}) {
  const readDir = deps.readdirSync || fs.readdirSync;
  const readFile = deps.readFileSync || fs.readFileSync;
  const statFile = deps.statSync || fs.statSync;
  let names;
  try { names = readDir(convDir); } catch { return { entries: [], malformed: 0 }; }
  const entries = [];
  let malformed = 0;
  for (const name of names.slice(0, HISTORY_LIMITS.MAX_SCAN_FILES)) {
    if (typeof name !== "string" || !name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!validateTaskId(id)) continue;
    const file = path.join(convDir, name);
    try {
      const stat = statFile(file);
      if (!stat.isFile || !stat.isFile()) continue;
      if (Number.isFinite(stat.size) && stat.size > CONTINUATION_LIMITS.MAX_TRANSCRIPT_BYTES) { malformed++; continue; }
      const raw = JSON.parse(readFile(file, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("record");
      const norm = normalizeTranscript(raw, id);
      const time = canonicalTime(norm, stat);
      entries.push({ id, raw, norm, time, mtimeMs: stat.mtimeMs });
    } catch { malformed++; }
  }
  entries.sort((a, b) => (b.time.ms - a.time.ms) || b.id.localeCompare(a.id));
  return { entries, malformed };
}

function statusFor(turns) {
  const latest = turns.slice().sort((a, b) => (b.time.ms - a.time.ms) || b.id.localeCompare(a.id))[0];
  return latest ? latest.status : "unknown";
}

function summary(entry, turns) {
  const root = entry.norm.root_task_id || entry.id;
  const created = turns.reduce((v, t) => Math.min(v, t.time.ms), Infinity);
  const latest = turns.reduce((v, t) => Math.max(v, t.time.ms), 0);
  return {
    id: root,
    rootTaskId: root,
    goal: String(turns.find(t => t.id === root)?.norm.goal || entry.norm.goal || "").slice(0, 400),
    createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
    lastActivityAt: latest ? new Date(latest).toISOString() : null,
    timestampSource: (turns.find(t => t.time.ms === created) || entry).time.source,
    turnCount: turns.length,
    status: statusFor(turns),
    latestTaskId: turns.slice().sort((a, b) => (b.time.ms - a.time.ms) || b.id.localeCompare(a.id))[0]?.id || root,
  };
}

function assembleSessions(convDir, options = {}, deps = {}) {
  const { entries, malformed } = loadEntries(convDir, deps);
  const byRoot = new Map();
  for (const entry of entries) {
    const root = entry.norm.root_task_id || entry.id;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(entry);
  }
  const sessions = [...byRoot.values()].map(turns => {
    turns.sort((a, b) => (a.norm.continuation_depth - b.norm.continuation_depth) || (a.time.ms - b.time.ms) || a.id.localeCompare(b.id));
    return { summary: summary(turns[turns.length - 1], turns), turns };
  }).sort((a, b) => {
    const at = Date.parse(a.summary.lastActivityAt || "") || 0;
    const bt = Date.parse(b.summary.lastActivityAt || "") || 0;
    return (bt - at) || b.summary.id.localeCompare(a.summary.id);
  });
  const pageSize = parsePage(options.pageSize, HISTORY_LIMITS.DEFAULT_PAGE_SIZE, HISTORY_LIMITS.MAX_PAGE_SIZE);
  const offset = parsePage(options.offset, 1, Number.MAX_SAFE_INTEGER) - 1;
  const page = sessions.slice(offset, offset + pageSize);
  const runs = entries.slice(offset, offset + pageSize).map(entry => ({
    id: entry.id, goal: entry.norm.goal.slice(0, 400), status: entry.norm.status,
    t: entry.time.iso, timestampSource: entry.time.source,
    parentTaskId: entry.norm.parent_task_id, rootTaskId: entry.norm.root_task_id,
    continuationDepth: entry.norm.continuation_depth,
  }));
  return { sessions: page.map(s => s.summary), runs, total: sessions.length, nextOffset: offset + page.length < sessions.length ? offset + page.length + 1 : null, malformed };
}

function buildSession(convDir, rootId, deps = {}) {
  if (!validateTaskId(rootId)) return null;
  const { entries } = loadEntries(convDir, deps);
  const matching = entries.filter(e => (e.norm.root_task_id || e.id) === rootId);
  if (!matching.length) return null;
  matching.sort((a, b) => (a.norm.continuation_depth - b.norm.continuation_depth) || (a.time.ms - b.time.ms) || a.id.localeCompare(b.id));
  const limited = matching.slice(0, HISTORY_LIMITS.MAX_SESSION_TURNS);
  const turns = limited.map(e => {
    const answer = resolveFinalAnswer(e.raw);
    return {
      id: e.id, goal: e.norm.goal, status: e.norm.status, result: answer.result,
      error: answer.error, t: e.time.iso, timestampSource: e.time.source,
      parentTaskId: e.norm.parent_task_id, rootTaskId: e.norm.root_task_id,
      continuationDepth: e.norm.continuation_depth, workState: safeWorkProjection(e.raw.work_state),
      steps: Array.isArray(e.raw.steps) ? e.raw.steps.filter(s => s && s.type !== "thought").slice(0, 200).map(s => ({
        type: s && typeof s.type === "string" ? s.type : "step",
        text: s && typeof s.text === "string" ? s.text.slice(0, 1000) : "",
        tool: s && typeof s.tool === "string" ? s.tool : undefined,
      })) : [],
    };
  });
  return { ...summary(limited[limited.length - 1], limited), turns, partial: !matching.some(e => e.id === rootId) };
}

function buildTask(convDir, taskId, deps = {}) {
  if (!validateTaskId(taskId)) return null;
  const { entries } = loadEntries(convDir, deps);
  const entry = entries.find(item => item.id === taskId);
  if (!entry) return null;
  const answer = resolveFinalAnswer(entry.raw);
  return {
    id: entry.id, goal: entry.norm.goal, status: entry.norm.status, result: answer.result,
    error: answer.error, t: entry.time.iso, timestampSource: entry.time.source,
    parent_task_id: entry.norm.parent_task_id, root_task_id: entry.norm.root_task_id,
    continuation_depth: entry.norm.continuation_depth, work_state: safeWorkProjection(entry.raw.work_state),
    steps: Array.isArray(entry.raw.steps) ? entry.raw.steps.filter(s => s && s.type !== "thought").slice(0, 200).map(s => ({
      type: s && typeof s.type === "string" ? s.type : "step",
      text: s && typeof s.text === "string" ? s.text.slice(0, 1200) : "",
      tool: s && typeof s.tool === "string" ? s.tool.slice(0, 100) : undefined,
      summary: s && typeof s.summary === "string" ? s.summary.slice(0, 500) : undefined,
    })) : [],
  };
}

module.exports = { HISTORY_LIMITS, canonicalTime, safeWorkProjection, loadEntries, assembleSessions, buildSession, buildTask };
