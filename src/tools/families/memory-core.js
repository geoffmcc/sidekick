"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const platformKernel = require("../../platform/kernel");
const { redactSensitive } = require("../../redact");
const { buildMemoryBrief } = require("../../memory");
const toolContext = require("../context");
const { sidekick_memory_manage } = require("./memory-lifecycle");
const { extractHandoffMemories } = require("./memory-handoff");
const { scopedProject, assertInScope } = require("./memory-scope");

function jsonText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

function memoryClassForToolType(type) {
  if (["session", "incident", "deployment", "experiment", "release"].includes(type)) return "episodic";
  if (type === "procedure") return "procedural";
  if (type === "open_thread") return "prospective";
  if (type === "negative") return "negative";
  if (type === "artifact") return "artifact";
  if (type === "observation") return "observational";
  if (type === "working") return "working";
  return "semantic";
}

function recordMemoryEvent(eventType, payload, options = {}) {
  try {
    platformKernel.appendEvent({ event_type: eventType, source: "memory", actor_id: toolContext.getExecutionSource() || "unknown", subject_type: options.subjectType || null, subject_id: options.subjectId || null, project_id: options.project || payload.project || null, task_id: options.taskId || payload.task_id || null, severity: options.severity || "info", payload, sensitivity: "normal", correlation_id: options.taskId || options.subjectId || null });
  } catch (e) {}
}

function buildScopedMemoryBrief(goal, project, options = {}) {
  const current = dbStore.searchMemories({ project, type: options.type || "all", limit: options.limit || 30 })
    .filter(memory => memory.current !== false && memory.state !== "expired" && memory.state !== "deleted")
    .map(memory => ({ id: memory.id, type: memory.type, class: memory.memory_class, scope: `${memory.primary_scope_type || (memory.project ? "project" : "global")}:${memory.primary_scope_id || memory.project || "global"}`, summary: memory.summary || memory.content, confidence: memory.confidence, source: memory.source, source_ref: memory.source_ref, last_verified: memory.last_confirmed_at || memory.last_seen_at, why_selected: project && memory.project === project ? "project scope match" : "global or unscoped match" }));
  return { goal: goal || null, project: project || null, selected: current.slice(0, options.limit || 10), sections: buildMemoryBrief(goal || project || "memory", { project }) || null, excluded_policy: "Expired, deleted, disabled, superseded, and unrelated project memories are excluded from normal recall.", generated_at: new Date().toISOString() };
}

async function sidekick_memory({ action, id, project, type, memory_class, content, summary, scope_type, scope_id, source, evidence, confidence, tags, query, limit, reason, correct_to, fresh_eyes, historical }) {
  let effectiveProject;
  try { effectiveProject = scopedProject(project); }
  catch (error) { return { content: [{ type: "text", text: error.message }], isError: true }; }
  if (action === "remember") {
    if (!content && !summary) return { content: [{ type: "text", text: "content or summary required" }], isError: true };
    const text = redactSensitive(content || summary);
    const memory = dbStore.upsertMemory({ type: type || "fact", project: effectiveProject, content: text, summary: redactSensitive(summary || text), tags: normalizeTags(tags), confidence: Number.isFinite(confidence) ? confidence : 0.8, source: source || "explicit", source_tool: "sidekick_memory", automatic: false, memory_class: memory_class || memoryClassForToolType(type || "fact"), primary_scope_type: scope_type || (effectiveProject ? "project" : "global"), primary_scope_id: scope_id || effectiveProject || null, evidence_excerpt: redactSensitive(evidence || text), directness: "direct", source_authority: source === "correction" ? 10 : 8, metadata: { user_controlled: true, reason: reason || null } });
    dbStore.auditMemoryEvent("remember", "memory", memory.id, { project, type: memory.type }, toolContext.getExecutionSource());
    recordMemoryEvent("memory.remembered", { memory_id: memory.id, project: memory.project, type: memory.type, source: memory.source }, { subjectType: "memory", subjectId: memory.id, project: memory.project });
    return jsonText({ ok: true, memory });
  }
  if (action === "query" || action === "list") {
    const memories = fresh_eyes ? [] : dbStore.searchMemories({ query, project: effectiveProject, type: type || "all", limit: limit || 20, includeDisabled: historical === true }).filter(m => historical === true || (m.current !== false && m.state !== "expired" && m.state !== "deleted"));
    return jsonText({ ok: true, count: memories.length, memories, brief: query ? buildScopedMemoryBrief(query, effectiveProject, { type: type || "all", limit: limit || 10 }) : null, fresh_eyes: fresh_eyes === true });
  }
  if (action === "get" || action === "explain") {
    const memory = dbStore.getMemoryById(id, { includeDisabled: true });
    if (memory && !effectiveProject) { /* unrestricted context */ }
    else if (memory) { try { assertInScope(memory); } catch { return { content: [{ type: "text", text: "Memory not found: " + id }], isError: true }; } }
    if (!memory) return { content: [{ type: "text", text: "Memory not found: " + id }], isError: true };
    return jsonText({ ok: true, memory, evidence: dbStore.getMemoryEvidence(id), why_known: { source: memory.source, source_ref: memory.source_ref, authority: memory.source_authority, confidence: memory.confidence, components: memory.confidence_components } });
  }
  if (action === "confirm") return sidekick_memory_manage({ action: "confirm", id, confirmed_by: source || "user" });
  if (action === "forget") return sidekick_memory_manage({ action: "delete", id, reason: reason || "user_forget" });
  if (action === "expire") return sidekick_memory_manage({ action: "expire", id, reason: reason || "manual_expire" });
  if (action === "pin") {
    try { assertInScope(dbStore.getMemoryById(id, { includeDisabled: true })); } catch { return { content: [{ type: "text", text: "Memory not found: " + id }], isError: true }; }
    const result = dbStore.getDb().prepare("UPDATE memories SET pinned = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    dbStore.auditMemoryEvent("pin", "memory", id, { reason }, toolContext.getExecutionSource());
    return { content: [{ type: "text", text: result.changes ? `Memory ${id} pinned` : `Memory not found: ${id}` }], isError: result.changes === 0 };
  }
  if (action === "correct") {
    if (!id || !correct_to) return { content: [{ type: "text", text: "id and correct_to required" }], isError: true };
    const old = dbStore.getMemoryById(id, { includeDisabled: true });
    try { assertInScope(old); } catch { return { content: [{ type: "text", text: "Memory not found: " + id }], isError: true }; }
    if (!old) return { content: [{ type: "text", text: "Memory not found: " + id }], isError: true };
    dbStore.softDeleteMemory(id, reason || "corrected");
    const replacement = dbStore.upsertMemory({ type: old.type, project: old.project, content: redactSensitive(correct_to), summary: redactSensitive(correct_to), confidence: 0.95, source: "user_correction", source_tool: "sidekick_memory", automatic: false, memory_class: old.memory_class, primary_scope_type: old.primary_scope_type, primary_scope_id: old.primary_scope_id, supersedes_id: id, evidence_excerpt: redactSensitive(correct_to), directness: "direct", source_authority: 10, metadata: { corrected_memory_id: id, correction_reason: reason || null } });
    dbStore.auditMemoryEvent("correct", "memory", id, { replacement_id: replacement.id, reason }, toolContext.getExecutionSource());
    recordMemoryEvent("memory.corrected", { memory_id: id, replacement_id: replacement.id, project: replacement.project, type: replacement.type, reason: reason || null }, { subjectType: "memory", subjectId: replacement.id, project: replacement.project });
    return jsonText({ ok: true, old_memory: id, replacement });
  }
  if (action === "health") return jsonText({ ok: true, stats: dbStore.getMemoryIntelligenceStats() });
  if (action === "conflicts") return jsonText({ ok: true, memories: dbStore.searchMemories({ project: effectiveProject, includeDisabled: true, limit: limit || 100 }).filter(m => m.conflict_group || m.metadata?.conflicts_with) });
  if (action === "backfill") {
    const keys = Object.entries(dbStore.getAllKV()).map(([key, entry]) => ({ key, ...(entry || {}) })).filter(entry => (!effectiveProject || entry.project === effectiveProject) && /handoff|resume|plan|next[_ -]?step/i.test(`${entry.key} ${entry.category || ""}`)).slice(0, limit || 25);
    const report = { scanned: keys.length, handoffs: 0, memories: 0, errors: [] };
    for (const entry of keys) {
      try {
        const handoff = dbStore.saveHandoff({ kv_key: entry.key, project: entry.project || effectiveProject || null, title: entry.key, source: "backfill", content: entry.value, extraction_state: "pending" });
        const memories = extractHandoffMemories(handoff, { project: entry.project || project || null });
        recordMemoryEvent("memory.handoff_backfilled", { handoff_id: handoff.id, key: handoff.kv_key, project: handoff.project, memories_created: memories.length }, { subjectType: "memory_handoff", subjectId: handoff.id, project: handoff.project, taskId: handoff.task_id });
        report.handoffs++; report.memories += memories.length;
      } catch (e) { report.errors.push(`${entry.key}: ${e.message}`); }
    }
    return jsonText({ ok: true, report });
  }
  return { content: [{ type: "text", text: "Invalid action. Use remember, query, explain, list, get, confirm, correct, forget, pin, expire, conflicts, health, backfill" }], isError: true };
}

const descriptors = Object.freeze([Object.freeze({
  name: "memory",
  description: "Typed memory operations: remember, query, explain, correct, forget, pin, expire, inspect conflicts/health, and backfill high-semantic sources such as handoffs.",
  schema: z.object({ action: z.enum(["remember", "query", "explain", "list", "get", "confirm", "correct", "forget", "pin", "expire", "conflicts", "health", "backfill"]).describe("Memory action"), id: z.string().optional(), project: z.string().optional(), type: z.string().optional(), memory_class: z.string().optional(), content: z.string().optional(), summary: z.string().optional(), scope_type: z.string().optional(), scope_id: z.string().optional(), source: z.string().optional(), evidence: z.string().optional(), confidence: z.number().optional(), tags: z.union([z.string(), z.array(z.string())]).optional(), query: z.string().optional(), limit: z.number().optional(), reason: z.string().optional(), correct_to: z.string().optional(), fresh_eyes: z.boolean().optional(), historical: z.boolean().optional() }),
  args: { action: "string (remember|query|explain|list|get|confirm|correct|forget|pin|expire|conflicts|health|backfill)", id: "string (optional memory id)", project: "string (optional)", type: "string (optional)", memory_class: "string (optional semantic|episodic|procedural|working|prospective|negative|relational|artifact|observational|capability)", content: "string (for remember)", summary: "string (optional)", scope_type: "string (optional)", scope_id: "string (optional)", source: "string (optional)", evidence: "string (optional)", confidence: "number (optional)", tags: "string|array (optional)", query: "string (for query)", limit: "number (optional)", correct_to: "string (for correct)", fresh_eyes: "boolean (optional)", historical: "boolean (optional)" },
  risk: "medium", category: "Context & Learning", source: "builtin", family: "memory-core", handler: sidekick_memory,
})]);

module.exports = { descriptors, sidekick_memory };
