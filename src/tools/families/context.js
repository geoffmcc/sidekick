"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const qdrantStore = require("../../qdrant");
const { redactSensitive } = require("../../redact");

const DEFAULT_CONTEXT = {
  projects: {},
  decisions: [],
  problems: [],
  patterns: [],
  sessions: [],
  memories: []
};

function loadContext() {
  return dbStore.loadDocument("context", DEFAULT_CONTEXT);
}

function saveContext(ctx) {
  dbStore.setDocument("context", ctx);
}

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function simpleSimilarity(text1, text2) {
  const words1 = text1.toLowerCase().split(/\s+/);
  const words2 = text2.toLowerCase().split(/\s+/);
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

let inferenceService = null;
try { inferenceService = require("../../compute/inference-service"); } catch {}

async function generateEmbedding(text) {
  // Embeddings route through Compute — the single inference authority — not a
  // direct Ollama call. Context is private, so placement keeps it on
  // local/trusted providers. Best-effort: null degrades similarity search to the
  // lexical fallback gracefully.
  if (!inferenceService || !text) return null;
  const model = process.env.SIDEKICK_EMBEDDING_MODEL || "nomic-embed-text";
  try {
    const result = await inferenceService.embed({
      input: text,
      model,
      dataClassification: "private",
      preferences: { allowFallback: true },
    });
    return result.embedding || null;
  } catch {
    return null;
  }
}

const CONTEXT_COLLECTIONS = [
  { type: "decision", filter: "decisions", key: "decisions" },
  { type: "problem", filter: "problems", key: "problems" },
  { type: "pattern", filter: "patterns", key: "patterns" },
  { type: "session", filter: "sessions", key: "sessions" },
  { type: "memory", filter: "memories", key: "memories" }
];

function structuredMemoryToContextItem(mem) {
  if (!mem || mem.enabled === false || mem.state === "deleted" || mem.state === "expired") return null;
  return {
    id: mem.id,
    date: mem.last_seen_at || mem.updated_at,
    type: mem.type,
    project: mem.project,
    summary: mem.summary || mem.content,
    content: mem.content,
    tool: mem.source_tool,
    outcome: mem.metadata?.outcome,
    confidence: mem.confidence,
    times_confirmed: mem.times_confirmed,
    structured: true
  };
}

function findStructuredMemoryById(id, type = "all") {
  if (!contextTypeMatches(type || "all", { type: "memory", filter: "memories" })) return null;
  const mem = dbStore.getMemoryById(String(id || "").trim(), { includeDisabled: true });
  return structuredMemoryToContextItem(mem);
}

function contextTypeMatches(filter, entry) {
  return !filter || filter === "all" || filter === entry.filter || filter === entry.type;
}

function contextItemIsActive(item) {
  return item && item.enabled !== false && item.state !== "deleted" && item.state !== "disabled" && item.state !== "expired";
}

function findContextItemById(ctx, id, type = "all") {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  for (const entry of CONTEXT_COLLECTIONS) {
    if (!contextTypeMatches(type || "all", entry)) continue;
    const list = Array.isArray(ctx[entry.key]) ? ctx[entry.key] : [];
    const index = list.findIndex(item => item && item.id === wanted);
    if (index >= 0) return { ...entry, item: list[index], index };
  }
  return null;
}

function formatContextRecallResult(type, item) {
  if (type === "decision") return `[Decision ${item.id}] ${item.date}\nContext: ${item.context}\nDecision: ${item.decision}\nReasoning: ${item.reasoning || "N/A"}`;
  if (type === "problem") return `[Problem ${item.id}] ${item.date}\nDescription: ${item.description}\nSolution: ${item.solution || "Unresolved"}`;
  if (type === "pattern") return `[Pattern ${item.id}] ${item.date}\nDescription: ${item.description}\nExample: ${item.example || "N/A"}`;
  if (type === "session") return `[Session ${item.id}] ${item.date}\nSummary: ${item.summary}\nTopics: ${(item.topics || []).join(", ")}\nOutcome: ${item.outcome || "N/A"}`;
  if (type === "memory") return `[Memory ${item.id}] ${item.date}\nType: ${item.type || "memory"}\nProject: ${item.project || "N/A"}\nSummary: ${item.summary || item.content || "N/A"}\nTool: ${item.tool || "N/A"}\nOutcome: ${item.outcome || "N/A"}\nConfidence: ${item.confidence || "N/A"}\nConfirmations: ${item.times_confirmed || "N/A"}`;
  return `[Context ${item.id}] ${JSON.stringify(item, null, 2)}`;
}

function updateLegacyContextItem(id, action, reason) {
  const ctx = loadContext();
  const found = findContextItemById(ctx, id, "all");
  if (!found) return { found: false };

  const now = new Date().toISOString();
  const item = found.item;
  if (action === "delete") {
    item.enabled = false; item.state = "deleted"; item.deleted_at = now; item.delete_reason = reason || "user_deleted";
  } else if (action === "disable") {
    item.enabled = false; item.state = "disabled"; item.disabled_at = now; item.disable_reason = reason || "user_disabled";
  } else if (action === "expire") {
    item.enabled = false; item.state = "expired"; item.expired_at = now; item.expire_reason = reason || "manual_expire";
  } else if (action === "restore") {
    item.enabled = true; item.state = "active"; item.restored_at = now;
    delete item.deleted_at; delete item.disabled_at; delete item.expired_at;
  } else {
    return { found: true, supported: false, type: found.type };
  }
  item.updated_at = now;
  saveContext(ctx);
  return { found: true, supported: true, type: found.type, id };
}

async function searchContext(ctx, query, type, limit = 10) {
  const results = [];
  const structuredExact = findStructuredMemoryById(query, type);
  if (structuredExact) return [{ type: "memory", item: structuredExact, score: 1 }];
  const exact = findContextItemById(ctx, query, type);
  if (exact && contextItemIsActive(exact.item)) return [{ type: exact.type, item: exact.item, score: 1 }];

  const qdrantAvailable = await qdrantStore.isAvailable();
  if (qdrantAvailable && type !== "memories") {
    const embedding = await generateEmbedding(query);
    if (embedding) {
      try {
        const filter = type && type !== "all" ? { must: [{ key: "type", match: { value: type } }] } : null;
        const semanticResults = await qdrantStore.search(embedding, limit, filter);
        for (const r of semanticResults) results.push({ type: r.payload.type, item: r.payload.data, score: r.score });
      } catch (e) {}
    }
  }

  if (type === "all" || type === "memories") {
    const structuredMemories = dbStore.searchMemories({ type: "all", limit: Math.max(limit * 5, 50) });
    for (const mem of structuredMemories) {
      const text = `${mem.type || ""} ${mem.project || ""} ${mem.content || ""} ${mem.summary || ""} ${mem.source_tool || ""} ${(mem.tags || []).join(" ")}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) results.push({ type: "memory", item: { id: mem.id, date: mem.last_seen_at || mem.updated_at, type: mem.type, project: mem.project, summary: mem.summary || mem.content, content: mem.content, tool: mem.source_tool, outcome: mem.metadata?.outcome, confidence: mem.confidence, times_confirmed: mem.times_confirmed, structured: true }, score: score * (mem.confidence || 1) });
    }
  }

  const collections = [
    ["decisions", "decision", item => `${item.context} ${item.decision} ${item.reasoning}`],
    ["problems", "problem", item => `${item.description} ${item.solution || ""}`],
    ["patterns", "pattern", item => `${item.description} ${item.example || ""}`],
    ["sessions", "session", item => `${item.summary || ""} ${(item.topics || []).join(" ")} ${item.notes || ""}`],
    ["memories", "memory", item => `${item.summary || ""} ${item.goal || ""} ${item.args || ""} ${item.tool || ""} ${(item.tools || []).join(" ")}`]
  ];
  for (const [key, entryType, textFor] of collections) {
    if (type !== "all" && type !== key) continue;
    for (const item of (ctx[key] || [])) {
      if (!contextItemIsActive(item)) continue;
      const score = simpleSimilarity(query, textFor(item));
      if (score > 0.1) results.push({ type: entryType, item, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

async function sidekick_context({ action, project, context, decision, reasoning, problem, solution, pattern, summary, topics, outcome, notes, query, type, limit }) {
  const allowedActions = ["track_project", "track_decision", "track_problem", "track_pattern", "track_session", "recall", "suggest", "summarize", "list"];
  if (!allowedActions.includes(action)) return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };

  const ctx = loadContext();
  const now = new Date().toISOString();
  if (action === "track_project") {
    if (!project) return { content: [{ type: "text", text: "project required" }], isError: true };
    if (!ctx.projects[project]) ctx.projects[project] = { name: project, created: now, lastWorked: now, sessions: 0, active: true };
    else { ctx.projects[project].lastWorked = now; ctx.projects[project].sessions++; }
    saveContext(ctx);
    return { content: [{ type: "text", text: `Tracked project: ${project}` }] };
  }
  if (action === "track_decision") {
    if (!context || !decision) return { content: [{ type: "text", text: "context and decision required" }], isError: true };
    const dec = { id: generateId("dec"), date: now, project: project || null, context, decision, reasoning: reasoning || null, outcome: null };
    ctx.decisions.push(dec); if (project && ctx.projects[project]) ctx.projects[project].lastWorked = now; saveContext(ctx);
    try { if (await qdrantStore.isAvailable()) { const embedding = await generateEmbedding(`${context} ${decision} ${reasoning || ""}`); if (embedding) await qdrantStore.upsert(dec.id, embedding, { type: "decision", data: dec }); } } catch (e) {}
    return { content: [{ type: "text", text: `Tracked decision: ${decision} (id: ${dec.id})` }] };
  }
  if (action === "track_problem") {
    if (!problem) return { content: [{ type: "text", text: "problem required" }], isError: true };
    const prob = { id: generateId("prob"), date: now, project: project || null, description: problem, solution: solution || null, resolved: !!solution };
    ctx.problems.push(prob); if (project && ctx.projects[project]) ctx.projects[project].lastWorked = now; saveContext(ctx);
    try { if (await qdrantStore.isAvailable()) { const embedding = await generateEmbedding(`${problem} ${solution || ""}`); if (embedding) await qdrantStore.upsert(prob.id, embedding, { type: "problem", data: prob }); } } catch (e) {}
    return { content: [{ type: "text", text: `Tracked problem: ${problem} (id: ${prob.id})` }] };
  }
  if (action === "track_pattern") {
    if (!pattern) return { content: [{ type: "text", text: "pattern required" }], isError: true };
    const pat = { id: generateId("pat"), date: now, project: project || null, description: pattern, example: context || null };
    ctx.patterns.push(pat); saveContext(ctx);
    try { if (await qdrantStore.isAvailable()) { const embedding = await generateEmbedding(`${pattern} ${context || ""}`); if (embedding) await qdrantStore.upsert(pat.id, embedding, { type: "pattern", data: pat }); } } catch (e) {}
    return { content: [{ type: "text", text: `Tracked pattern: ${pattern} (id: ${pat.id})` }] };
  }
  if (action === "track_session") {
    if (!summary) return { content: [{ type: "text", text: "summary required" }], isError: true };
    const redactedSummary = redactSensitive(summary); const redactedNotes = notes ? redactSensitive(notes) : null;
    const topicList = topics ? topics.split(",").map(t => redactSensitive(t.trim())).filter(Boolean) : [];
    const sess = { id: generateId("sess"), date: now, project: project || null, summary: redactedSummary, topics: topicList, outcome: outcome || null, notes: redactedNotes };
    if (!ctx.sessions) ctx.sessions = []; ctx.sessions.push(sess); if (ctx.sessions.length > 100) ctx.sessions = ctx.sessions.slice(-100);
    if (project && ctx.projects[project]) ctx.projects[project].lastWorked = now; saveContext(ctx);
    try { if (await qdrantStore.isAvailable()) { const embedding = await generateEmbedding(`${redactedSummary} ${topicList.join(" ")} ${redactedNotes || ""}`); if (embedding) await qdrantStore.upsert(sess.id, embedding, { type: "session", data: sess }); } } catch (e) {}
    return { content: [{ type: "text", text: `Tracked session: ${redactedSummary} (id: ${sess.id})` }] };
  }
  if (action === "recall") {
    if (!query) return { content: [{ type: "text", text: "query required" }], isError: true };
    const results = await searchContext(ctx, query, type || "all", limit || 10);
    return { content: [{ type: "text", text: results.length ? results.map(r => formatContextRecallResult(r.type, r.item)).join("\n\n") : "No relevant context found" }] };
  }
  if (action === "suggest") {
    if (!query) return { content: [{ type: "text", text: "query required" }], isError: true };
    const results = await searchContext(ctx, query, "all", 5);
    if (!results.length) return { content: [{ type: "text", text: "No suggestions based on past context" }] };
    const suggestions = results.map(r => { const item = r.item; if (r.type === "decision") return `• You previously decided: "${item.decision}" because "${item.reasoning || "no reason recorded"}" (on ${item.date})`; if (r.type === "problem") return `• You encountered a similar problem: "${item.description}" - ${item.solution ? `solved with: "${item.solution}"` : "unresolved"}`; if (r.type === "pattern") return `• You have a pattern: "${item.description}"`; if (r.type === "session") return `• You had a session on ${item.date}: "${item.summary}" (${item.outcome || "no outcome recorded"})`; return `• Automatic memory from ${item.date}: "${item.summary || item.goal || item.tool}"`; }).join("\n");
    return { content: [{ type: "text", text: `Based on your past context:\n\n${suggestions}` }] };
  }
  if (action === "summarize") {
    const projectName = project || "all"; let summaryText = "# Context Summary";
    if (projectName !== "all") {
      const proj = ctx.projects[projectName]; if (!proj) return { content: [{ type: "text", text: `Project not found: ${projectName}` }], isError: true };
      summaryText += `\n\n## Project: ${projectName}\n- Created: ${proj.created}\n- Last worked: ${proj.lastWorked}\n- Sessions: ${proj.sessions}\n`;
      const sections = [["Decisions", ctx.decisions.filter(d => d.project === projectName), d => d.decision], ["Problems", ctx.problems.filter(p => p.project === projectName), p => `${p.description} ${p.resolved ? "(resolved)" : "(unresolved)"}`], ["Patterns", ctx.patterns.filter(p => p.project === projectName), p => p.description], ["Recent Sessions", (ctx.sessions || []).filter(s => s.project === projectName), s => `${s.summary} (${s.outcome || "N/A"})`], ["Automatic Memories", (ctx.memories || []).filter(m => m.project === projectName), m => m.summary || m.goal || m.tool || "memory"]];
      for (const [label, items, textFor] of sections) if (items.length) summaryText += `\n### ${label} (${items.length}):\n` + items.slice(-5).map(item => `- ${item.date}: ${textFor(item)}`).join("\n") + "\n";
    } else {
      summaryText += `\n\n## Overview\n- Total projects: ${Object.keys(ctx.projects).length}\n- Total decisions: ${ctx.decisions.length}\n- Total problems: ${ctx.problems.length}\n- Total patterns: ${ctx.patterns.length}\n- Total sessions: ${(ctx.sessions || []).length}\n- Automatic memories: ${(ctx.memories || []).length}\n`;
      const activeProjects = Object.values(ctx.projects).filter(p => p.active); if (activeProjects.length) summaryText += `\n### Active Projects:\n` + activeProjects.map(p => `- ${p.name} (last worked: ${p.lastWorked})`).join("\n") + "\n";
    }
    return { content: [{ type: "text", text: summaryText }] };
  }
  if (action === "list") {
    const items = []; if (!type || type === "all" || type === "decisions") items.push(`Decisions: ${ctx.decisions.length}`); if (!type || type === "all" || type === "problems") items.push(`Problems: ${ctx.problems.length}`); if (!type || type === "all" || type === "patterns") items.push(`Patterns: ${ctx.patterns.length}`); if (!type || type === "all" || type === "projects") items.push(`Projects: ${Object.keys(ctx.projects).length}`); if (!type || type === "all" || type === "sessions") items.push(`Sessions: ${(ctx.sessions || []).length}`); if (!type || type === "all" || type === "memories") items.push(`Automatic memories: ${(ctx.memories || []).length}`);
    return { content: [{ type: "text", text: items.join("\n") }] };
  }
}

// sidekick_project moved here in B-6: it aggregates KV, shared context, logs,
// and procedures for one project, and this family already owns the shared
// context store it reads. loadSharedContext is the legacy alias for this
// family's loadContext; the handler body is verbatim.
const { loadProcedures } = require("../../core/procedures-store");
const loadSharedContext = loadContext;

async function sidekick_project({ name, include }) {
  const sections = (include || "kv,context").split(",").map(s => s.trim());
  const output = {};
  if (sections.includes("kv")) {
    const allKV = dbStore.getAllKV();
    const kvResults = [];
    for (const [key, entry] of Object.entries(allKV)) {
      if (typeof entry === 'object' && entry !== null && entry.project === name) {
        kvResults.push({ key, value: typeof entry.value === 'string' ? entry.value.substring(0, 200) : entry.value, updated: entry.updated });
      }
    }
    output.kv = kvResults;
  }
  if (sections.includes("context")) {
    const ctx = loadSharedContext();
    const structuredMemories = dbStore.searchMemories({ project: name, limit: 20 }).map(i => ({
      type: i.type || "memory",
      summary: i.summary || i.content,
      created: i.last_seen_at || i.updated_at,
      project: i.project
    }));
    const items = [
      ...structuredMemories,
      ...(ctx.decisions || []).map(i => ({ type: "decision", summary: i.decision, created: i.date, project: i.project })),
      ...(ctx.problems || []).map(i => ({ type: "problem", summary: i.description, created: i.date, project: i.project })),
      ...(ctx.patterns || []).map(i => ({ type: "pattern", summary: i.description, created: i.date, project: i.project })),
      ...(ctx.sessions || []).map(i => ({ type: "session", summary: i.summary, created: i.date, project: i.project })),
      ...(ctx.memories || []).map(i => ({ type: i.type || "memory", summary: i.summary || i.goal || i.tool, created: i.date, project: i.project }))
    ].filter(i => i.project === name);
    output.context = items.slice(-20).map(i => ({
      type: i.type,
      summary: String(i.summary || "").substring(0, 200),
      created: i.created
    }));
  }
  if (sections.includes("logs")) {
    const toolLogs = dbStore.readToolLogs(20);
    output.logs = toolLogs.map(l => ({
      time: l.t, tool: l.n, ok: l.ok, summary: l.s
    }));
  }
  if (sections.includes("procedures")) {
    const procs = loadProcedures();
    output.procedures = Object.keys(procs).filter(n => n.toLowerCase().includes(name.toLowerCase()));
  }
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

const projectSchema = z.object({
    name: z.string().describe("Project name"),
    include: z.string().optional().describe("Sections to include: kv,context,logs,procedures (default: kv,context)")
  });

const descriptors = Object.freeze([Object.freeze({
  name: "project",
  description: "Get complete project context in one call: KV entries, context tracking, recent logs, procedures.",
  schema: projectSchema,
  args: { name: "string (project name)", include: "string (optional, comma-separated: kv,context,logs,procedures - default kv,context)" },
  risk: "low",
  category: "Efficiency",
  source: "builtin",
  family: "context",
  handler: sidekick_project,
}), Object.freeze({
  name: "context",
  description: "Persistent intelligent context management (track projects, decisions, problems, patterns, sessions, automatic memories; recall and suggest based on past context)",
  schema: z.object({ action: z.enum(["track_project", "track_decision", "track_problem", "track_pattern", "track_session", "recall", "suggest", "summarize", "list"]).describe("Context action to perform"), project: z.string().optional().describe("Project name (for tracking and filtering)"), context: z.string().optional().describe("Context description (for decisions/patterns)"), decision: z.string().optional().describe("Decision made (for track_decision)"), reasoning: z.string().optional().describe("Reasoning behind decision (for track_decision)"), problem: z.string().optional().describe("Problem description (for track_problem)"), solution: z.string().optional().describe("Solution to problem (for track_problem)"), pattern: z.string().optional().describe("Pattern description (for track_pattern)"), summary: z.string().optional().describe("Session summary (for track_session)"), topics: z.string().optional().describe("Comma-separated session topics (for track_session)"), outcome: z.string().optional().describe("Session outcome: success, partial, or abandoned (for track_session)"), notes: z.string().optional().describe("Additional session notes (for track_session)"), query: z.string().optional().describe("Search query (for recall/suggest)"), type: z.string().optional().describe("Context type: decisions, problems, patterns, projects, sessions, memories, or all (default: all)"), limit: z.number().optional().describe("Maximum results to return (default: 10)") }),
  args: { action: "string", project: "string (optional)", context: "string (optional)", decision: "string (optional)", reasoning: "string (optional)", problem: "string (optional)", solution: "string (optional)", pattern: "string (optional)", query: "string (optional)", type: "string (optional: decisions|problems|patterns|projects|sessions|memories|all)", limit: "number (optional)" },
  risk: "medium", category: "Context & Learning", source: "builtin", family: "context", handler: sidekick_context,
})]);

module.exports = { descriptors, sidekick_context, sidekick_project, loadContext, saveContext, searchContext, simpleSimilarity, generateEmbedding, findStructuredMemoryById, findContextItemById, formatContextRecallResult, updateLegacyContextItem, contextItemIsActive };
