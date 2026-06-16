const dbStore = require("./db");
const { redactSensitive } = require("./redact");

const PROJECT_RE = /^[a-z][a-z0-9_]*$/;
const configuredMax = Number(process.env.SIDEKICK_AUTO_MEMORY_MAX || 500);
const MAX_AUTO_MEMORY = Number.isFinite(configuredMax) ? Math.max(1, configuredMax) : 500;
const AUTO_MEMORY_ENABLED = !["0", "false", "off"].includes(String(process.env.SIDEKICK_AUTO_MEMORY || "1").toLowerCase());

const DEFAULT_CONTEXT = {
  projects: {},
  decisions: [],
  problems: [],
  patterns: [],
  sessions: [],
  memories: []
};

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function normalizeContext(ctx) {
  const out = ctx && typeof ctx === "object" ? ctx : {};
  out.projects = out.projects && typeof out.projects === "object" ? out.projects : {};
  out.decisions = Array.isArray(out.decisions) ? out.decisions : [];
  out.problems = Array.isArray(out.problems) ? out.problems : [];
  out.patterns = Array.isArray(out.patterns) ? out.patterns : [];
  out.sessions = Array.isArray(out.sessions) ? out.sessions : [];
  out.memories = Array.isArray(out.memories) ? out.memories : [];
  return out;
}

function loadContext() {
  return normalizeContext(dbStore.loadDocument("context", DEFAULT_CONTEXT));
}

function saveContext(ctx) {
  dbStore.setDocument("context", normalizeContext(ctx));
}

function truncate(value, max = 500) {
  const text = redactSensitive(String(value ?? ""));
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    let text;
    if (typeof value === "string") {
      text = value;
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    parts.push(`${key}=${truncate(text, 120)}`);
  }
  return parts.join(", ");
}

function inferProjectFromArgs(args, fallback) {
  if (fallback && PROJECT_RE.test(fallback)) return fallback;
  if (args && typeof args === "object") {
    for (const key of ["project", "name", "repo", "repository"]) {
      const value = args[key];
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
        if (PROJECT_RE.test(normalized)) return normalized;
      }
    }
  }
  return null;
}

function inferProjectFromText(text) {
  const match = String(text || "").match(/\b(?:project|repo|repository)\s+([a-z][a-z0-9_-]{1,60})\b/i);
  if (!match) return null;
  const normalized = match[1].toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return PROJECT_RE.test(normalized) ? normalized : null;
}

function touchProject(ctx, project, date) {
  if (!project) return;
  if (!ctx.projects[project]) {
    ctx.projects[project] = {
      name: project,
      created: date,
      lastWorked: date,
      sessions: 0,
      active: true
    };
  } else {
    ctx.projects[project].lastWorked = date;
  }
}

function pushBounded(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function shouldRememberTool(name, success) {
  if (!AUTO_MEMORY_ENABLED) return false;
  if (!name || name === "sidekick_context" || name === "sidekick_knowledge") return false;
  if (name === "sidekick_get" || name === "sidekick_list" || name === "sidekick_read") return false;
  return success || name.startsWith("sidekick_db_") || name === "sidekick_bash";
}

function recordToolCallMemory({ name, args, duration, success, summary, source }) {
  if (!shouldRememberTool(name, success)) return null;
  const ctx = loadContext();
  const date = nowIso();
  const project = inferProjectFromArgs(args);
  const memory = {
    id: generateId("mem"),
    type: "tool_call",
    date,
    project,
    source: source || "unknown",
    tool: name,
    success: !!success,
    duration_ms: Number.isFinite(duration) ? Math.round(duration) : null,
    args: summarizeArgs(args),
    summary: truncate(summary, 300),
    automatic: true
  };
  touchProject(ctx, project, date);
  pushBounded(ctx.memories, memory, MAX_AUTO_MEMORY);
  saveContext(ctx);
  return memory;
}

function compactToolList(steps) {
  const tools = [];
  for (const step of steps || []) {
    if (step.type === "tool" && step.tool) tools.push(step.tool);
  }
  return [...new Set(tools)].slice(0, 12);
}

function getDoneText(steps) {
  const done = [...(steps || [])].reverse().find(s => s.type === "done");
  return done ? done.text || "" : "";
}

function recordAgentTaskMemory({ goal, steps, taskId, status }) {
  if (!AUTO_MEMORY_ENABLED) return null;
  const ctx = loadContext();
  const date = nowIso();
  const tools = compactToolList(steps);
  const doneText = getDoneText(steps);
  const project = inferProjectFromText(goal) || inferProjectFromArgs((steps || []).find(s => s.args)?.args);
  const errorCount = (steps || []).filter(s => s.type === "error" || String(s.result || "").startsWith("Error:")).length;
  const outcome = status || (errorCount > 0 ? "partial" : "success");
  const summary = truncate(doneText || goal, 600);
  const notes = truncate([
    `Goal: ${goal}`,
    tools.length ? `Tools: ${tools.join(", ")}` : "",
    errorCount ? `Errors: ${errorCount}` : ""
  ].filter(Boolean).join("\n"), 800);

  const session = {
    id: generateId("sess"),
    date,
    project,
    summary,
    topics: tools,
    outcome,
    notes,
    taskId: taskId || null,
    automatic: true
  };
  const memory = {
    id: generateId("mem"),
    type: "agent_task",
    date,
    project,
    source: "agent",
    summary,
    goal: truncate(goal, 400),
    tools,
    outcome,
    taskId: taskId || null,
    automatic: true
  };
  touchProject(ctx, project, date);
  if (project) ctx.projects[project].sessions = (ctx.projects[project].sessions || 0) + 1;
  pushBounded(ctx.sessions, session, 100);
  pushBounded(ctx.memories, memory, MAX_AUTO_MEMORY);
  saveContext(ctx);
  return { session, memory };
}

function tokens(text) {
  return new Set(String(text || "").toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length > 2));
}

function scoreText(query, text) {
  const q = tokens(query);
  if (q.size === 0) return 0;
  const t = tokens(text);
  let hits = 0;
  for (const word of q) if (t.has(word)) hits++;
  return hits / q.size;
}

function memoryText(item) {
  return [
    item.type,
    item.project,
    item.summary,
    item.goal,
    item.args,
    item.tool,
    item.outcome,
    Array.isArray(item.tools) ? item.tools.join(" ") : "",
    Array.isArray(item.topics) ? item.topics.join(" ") : "",
    item.notes
  ].filter(Boolean).join(" ");
}

function recallMemoryForText(query, options = {}) {
  const ctx = loadContext();
  const project = options.project || inferProjectFromText(query);
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));
  const candidates = [
    ...ctx.memories,
    ...ctx.sessions.map(s => ({ ...s, type: "session" })),
    ...ctx.decisions.map(d => ({ ...d, type: "decision", summary: d.decision, notes: d.reasoning })),
    ...ctx.problems.map(p => ({ ...p, type: "problem", summary: p.description, notes: p.solution })),
    ...ctx.patterns.map(p => ({ ...p, type: "pattern", summary: p.description, notes: p.example }))
  ].filter(item => !project || !item.project || item.project === project);

  const results = candidates
    .map(item => ({ item, score: scoreText(query, memoryText(item)) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.date || "").localeCompare(String(a.item.date || "")))
    .slice(0, limit)
    .map(r => r.item);

  return results;
}

function formatMemoryRecall(items) {
  if (!items || items.length === 0) return "";
  return items.map(item => {
    const label = item.type || "memory";
    const project = item.project ? ` project=${item.project}` : "";
    const date = item.date ? ` ${item.date}` : "";
    const detail = item.summary || item.goal || item.description || item.decision || "";
    const tools = Array.isArray(item.tools) && item.tools.length ? ` tools=${item.tools.join(",")}` : "";
    return `- [${label}${project}${date}] ${truncate(detail, 240)}${tools}`;
  }).join("\n");
}

module.exports = {
  loadContext,
  saveContext,
  recordToolCallMemory,
  recordAgentTaskMemory,
  recallMemoryForText,
  formatMemoryRecall,
  inferProjectFromArgs,
  inferProjectFromText
};
