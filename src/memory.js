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

const TYPE_WEIGHTS = {
  preference: 1.4,
  fact: 1.3,
  decision: 1.2,
  open_thread: 1.2,
  procedure: 1.1,
  session: 1,
  tool_call: 0.8,
  observation: 0.7
};

const EXTRACTION_RULES = [
  {
    type: "preference",
    confidence: 0.9,
    patterns: [
      /\bprefer(?:s|red|ring)?\b/i,
      /\b(?:use|keep|choose|avoid)\s+(?:sqlite|postgres|postgresql|qdrant|ollama|groq|node|powershell|bash)\b/i,
      /\bdon't use\b/i,
      /\bnever use\b/i
    ]
  },
  {
    type: "decision",
    confidence: 0.85,
    patterns: [
      /\bdecided\b/i,
      /\bdecision\b/i,
      /\bchose\b/i,
      /\bselected\b/i,
      /\bgoing with\b/i
    ]
  },
  {
    type: "open_thread",
    confidence: 0.75,
    patterns: [
      /\bTODO\b/i,
      /\bfollow up\b/i,
      /\bneeds? to\b/i,
      /\bblocked\b/i,
      /\bpending\b/i,
      /\binvestigate\b/i,
      /\bfix\b/i
    ]
  },
  {
    type: "fact",
    confidence: 0.72,
    patterns: [
      /\bis\b/i,
      /\bare\b/i,
      /\bhas\b/i,
      /\bhave\b/i,
      /\buses\b/i,
      /\blives in\b/i,
      /\bstored in\b/i,
      /\blocated at\b/i,
      /\bdefault(?:s)? to\b/i
    ]
  }
];

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

function toStructuredMemory(legacy) {
  return {
    type: legacy.type || "observation",
    project: legacy.project || null,
    content: legacy.summary || legacy.goal || legacy.tool || "memory",
    summary: legacy.summary || legacy.goal || legacy.tool || "memory",
    tags: [
      legacy.source || null,
      legacy.tool || null,
      legacy.outcome || null
    ].filter(Boolean),
    confidence: legacy.type === "agent_task" ? 0.75 : 0.55,
    source: legacy.source || "unknown",
    source_tool: legacy.tool || null,
    source_task_id: legacy.taskId || null,
    source_ref: legacy.id || null,
    metadata: legacy,
    automatic: true
  };
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
  const structured = dbStore.upsertMemory(toStructuredMemory(memory));
  dbStore.trimAutomaticMemories(MAX_AUTO_MEMORY);
  return structured || memory;
}

function compactToolList(steps) {
  const tools = [];
  for (const step of steps || []) {
    if (step.type === "tool" && step.tool) tools.push(step.tool);
  }
  return [...new Set(tools)].slice(0, 12);
}

function splitStatements(text) {
  return String(text || "")
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function scoreExtractionStatement(statement, rule) {
  let score = 0;
  for (const pattern of rule.patterns) {
    if (pattern.test(statement)) score++;
  }
  return score;
}

function buildMemoryTags(source, extra = []) {
  return [...new Set([source, ...extra].filter(Boolean))];
}

function createStructuredMemory({ type, project, content, summary, tags, confidence, source, sourceTool, sourceTaskId, sourceRef, metadata, automatic = true }) {
  return dbStore.upsertMemory({
    type,
    project: project || null,
    content: String(content || summary || "").trim(),
    summary: String(summary || content || "").trim(),
    tags: tags || [],
    confidence,
    source: source || "unknown",
    source_tool: sourceTool || null,
    source_task_id: sourceTaskId || null,
    source_ref: sourceRef || null,
    metadata: metadata || {},
    automatic
  });
}

function extractTaskMemories({ goal, steps, summary, notes, project, taskId, status }) {
  const textParts = [
    goal || "",
    summary || "",
    ...(steps || []).flatMap(step => [
      step.summary || "",
      step.text || "",
      step.result || "",
      typeof step.args === "object" ? JSON.stringify(step.args) : ""
    ])
  ];
  const text = textParts.filter(Boolean).join("\n");
  const statements = [...new Set(splitStatements(text).map(s => truncate(s, 400)).filter(Boolean))];
  const memories = [];
  const seen = new Set();

  for (const statement of statements) {
    for (const rule of EXTRACTION_RULES) {
      const hits = scoreExtractionStatement(statement, rule);
      if (hits === 0) continue;

      const normalized = `${rule.type}|${project || ""}|${statement.toLowerCase()}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const inferredProject = project || inferProjectFromText(statement) || inferProjectFromText(goal);
      const memory = createStructuredMemory({
        type: rule.type,
        project: inferredProject,
        content: statement,
        summary: statement,
        tags: buildMemoryTags("auto_extract", [status, taskId ? "task" : null, rule.type]),
        confidence: Math.min(0.98, rule.confidence + Math.min(hits * 0.03, 0.1)),
        source: "agent",
        sourceTool: "sidekick_agent",
        sourceTaskId: taskId || null,
        sourceRef: taskId || null,
        metadata: {
          goal: truncate(goal || "", 300),
          statement,
          extracted_from: "agent_task",
          status: status || null
        }
      });
      if (memory) memories.push(memory);
      if (memories.length >= 6) return memories;
      break;
    }
  }

  if (memories.length === 0 && text.trim()) {
    const inferredProject = project || inferProjectFromText(goal) || inferProjectFromText(text);
    const observation = createStructuredMemory({
      type: "observation",
      project: inferredProject,
      content: truncate(summary || goal || text, 400),
      summary: truncate(summary || goal || text, 400),
      tags: buildMemoryTags("auto_extract", [status]),
      confidence: 0.55,
      source: "agent",
      sourceTool: "sidekick_agent",
      sourceTaskId: taskId || null,
      sourceRef: taskId || null,
      metadata: {
        goal: truncate(goal || "", 300),
        extracted_from: "agent_task",
        status: status || null
      }
    });
    if (observation) memories.push(observation);
  }

  return memories;
}

function getDoneText(steps) {
  const done = [...(steps || [])].reverse().find(s => s.type === "done");
  return done ? done.text || "" : "";
}

function recordAgentTaskMemory({ goal, steps, taskId, status, project: projectArg }) {
  if (!AUTO_MEMORY_ENABLED) return null;
  const ctx = loadContext();
  const date = nowIso();
  const tools = compactToolList(steps);
  const doneText = getDoneText(steps);
  const project = projectArg || inferProjectFromText(goal) || inferProjectFromArgs((steps || []).find(s => s.args)?.args);
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
  const structured = createStructuredMemory({
    type: "session",
    project,
    content: summary,
    summary,
    tags: buildMemoryTags("auto_session", tools),
    confidence: 0.75,
    source: "agent",
    sourceTool: "sidekick_agent",
    sourceTaskId: taskId || null,
    sourceRef: taskId || null,
    metadata: { goal: truncate(goal, 400), outcome, tools, notes },
  });
  const extracted = extractTaskMemories({ goal, steps, summary, notes, project, taskId, status: outcome });
  dbStore.trimAutomaticMemories(MAX_AUTO_MEMORY);
  return { session, memory: structured || memory, extracted };
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
    item.content,
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
  const structured = dbStore.searchMemories({
    project,
    type: options.type || "all",
    limit: Math.max(limit * 10, 50)
  }).map(item => ({
    id: item.id,
    type: item.type,
    date: item.last_seen_at || item.updated_at,
    project: item.project,
    summary: item.summary || item.content,
    content: item.content,
    goal: item.metadata?.goal,
    args: item.metadata?.args,
    tool: item.source_tool,
    tools: item.metadata?.tools,
    outcome: item.metadata?.outcome,
    confidence: item.confidence,
    times_confirmed: item.times_confirmed,
    source: item.source,
    structured: true
  }));

  const candidates = [
    ...structured,
    ...ctx.memories,
    ...ctx.sessions.map(s => ({ ...s, type: "session" })),
    ...ctx.decisions.map(d => ({ ...d, type: "decision", summary: d.decision, notes: d.reasoning })),
    ...ctx.problems.map(p => ({ ...p, type: "problem", summary: p.description, notes: p.solution })),
    ...ctx.patterns.map(p => ({ ...p, type: "pattern", summary: p.description, notes: p.example }))
  ].filter(item => !project || !item.project || item.project === project);

  const results = candidates
    .map(item => ({ item, score: scoreText(query, memoryText(item)) }))
    .filter(r => r.score > 0)
    .sort((a, b) => {
      const weightedA = a.score * (TYPE_WEIGHTS[a.item.type] || 1) * (a.item.confidence || 1);
      const weightedB = b.score * (TYPE_WEIGHTS[b.item.type] || 1) * (b.item.confidence || 1);
      return weightedB - weightedA || String(b.item.date || "").localeCompare(String(a.item.date || ""));
    })
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
    const confidence = item.structured && item.confidence ? ` confidence=${item.confidence}` : "";
    const detail = item.summary || item.content || item.goal || item.description || item.decision || "";
    const tools = Array.isArray(item.tools) && item.tools.length ? ` tools=${item.tools.join(",")}` : "";
    return `- [${label}${project}${date}${confidence}] ${truncate(detail, 240)}${tools}`;
  }).join("\n");
}

module.exports = {
  loadContext,
  saveContext,
  recordToolCallMemory,
  recordAgentTaskMemory,
  extractTaskMemories,
  recallMemoryForText,
  formatMemoryRecall,
  inferProjectFromArgs,
  inferProjectFromText
};
