"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const { redactSensitive } = require("../../redact");
const toolContext = require("../context");

const HANDOFF_EXTRACTION_VERSION = "handoff-rules-v1";

function jsonText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function classifyHandoffLine(line) {
  const text = String(line || "").trim().replace(/^[-*]\s+/, "");
  if (!text || text.length < 8) return null;
  if (/secret|password|token|api[_ -]?key|private key|authorization:/i.test(text)) return null;
  const lower = text.toLowerCase();
  if (/^(decision|decided|rationale|chose|selected)\b/.test(lower)) return { type: "decision", memory_class: "semantic", confidence: 0.86 };
  if (/^(next step|follow up|todo|pending|unresolved|open problem|blocker|blocked|risk)\b/.test(lower)) return { type: "open_thread", memory_class: "prospective", confidence: 0.78, requires_confirmation: false };
  if (/^(failed|failure|do not|don't|avoid|rejected|dead end|did not work)\b/.test(lower)) return { type: "negative", memory_class: "negative", confidence: 0.78 };
  if (/^(procedure|runbook|worked command|validation|rollback|steps?)\b/.test(lower)) return { type: "procedure", memory_class: "procedural", confidence: 0.76 };
  if (/^(completed|done|changed|implemented|fixed|resolved)\b/.test(lower)) return { type: "session", memory_class: "episodic", confidence: 0.72 };
  if (/^(fact|verified|current|host|service|repo|repository|path|environment|uses|runs|is|are)\b/.test(lower)) return { type: "fact", memory_class: "semantic", confidence: 0.74 };
  return null;
}

function extractHandoffMemories(handoff, options = {}) {
  const project = options.project || handoff.project || null;
  const lines = String(handoff.redacted_content || handoff.content || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const created = [];
  const seen = new Set();
  for (const line of lines) {
    const classification = classifyHandoffLine(line);
    if (!classification) continue;
    const content = redactSensitive(line.replace(/^(decision|decided|rationale|next step|follow up|todo|pending|unresolved|open problem|blocker|blocked|risk|failed|failure|do not|don't|avoid|rejected|dead end|procedure|runbook|worked command|validation|rollback|completed|done|changed|implemented|fixed|resolved|fact|verified|current)\s*:?\s*/i, "").trim() || line);
    const fingerprint = `${handoff.id}|${handoff.content_hash}|${classification.type}|${content.toLowerCase()}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const memory = dbStore.upsertMemory({ type: classification.type, project, content, summary: content, tags: ["handoff", classification.type, handoff.kv_key || handoff.id].filter(Boolean), confidence: classification.confidence, source: "handoff", source_tool: "sidekick_handoff", source_task_id: handoff.task_id || null, source_ref: handoff.id, automatic: true, requires_confirmation: classification.requires_confirmation === true, memory_class: classification.memory_class, primary_scope_type: project ? "project" : "global", primary_scope_id: project, source_type: "handoff", evidence_excerpt: content, extraction_method: HANDOFF_EXTRACTION_VERSION, directness: "direct", source_authority: 6, artifact_hash: handoff.content_hash, fingerprint, metadata: { handoff_id: handoff.id, handoff_key: handoff.kv_key, handoff_version: handoff.version, handoff_hash: handoff.content_hash, extraction_version: HANDOFF_EXTRACTION_VERSION, memory_class: classification.memory_class, source_type: "handoff", evidence_excerpt: content } });
    if (memory) created.push(memory);
  }
  dbStore.updateHandoffExtraction(handoff.id, "processed", HANDOFF_EXTRACTION_VERSION);
  return created;
}

function recordHandoffEvent(eventType, payload, options = {}) {
  try {
    const platformKernel = require("../../platform/kernel");
    platformKernel.appendEvent({ event_type: eventType, source: "memory", actor_id: toolContext.getExecutionSource() || "unknown", subject_type: options.subjectType || null, subject_id: options.subjectId || null, project_id: options.project || payload.project || null, task_id: options.taskId || payload.task_id || null, severity: options.severity || "info", payload, sensitivity: "normal", correlation_id: options.taskId || options.subjectId || null });
  } catch (e) {}
}

async function sidekick_handoff({ action, id, key, project, title, content, source, task_id, reprocess, include_archived, limit }) {
  if (action === "create" || action === "update") {
    const handoffContent = content || (key ? dbStore.getKV(key)?.value : null);
    if (!handoffContent) return { content: [{ type: "text", text: "content required, or provide key for an existing KV handoff" }], isError: true };
    if (key && content) dbStore.setKV(key, content, project || dbStore.getKV(key)?.project || null, source || toolContext.getExecutionSource(), "handoff");
    const handoff = dbStore.saveHandoff({ id, kv_key: key, project, title, source: source || toolContext.getExecutionSource(), task_id, content: handoffContent, extraction_state: "pending" });
    const memories = extractHandoffMemories(handoff, { project });
    recordHandoffEvent("memory.handoff_processed", { handoff_id: handoff.id, key: handoff.kv_key, project: handoff.project, version: handoff.version, memories_created: memories.length, extraction_state: "processed" }, { subjectType: "memory_handoff", subjectId: handoff.id, project: handoff.project, taskId: handoff.task_id });
    return jsonText({ ok: true, handoff: dbStore.getHandoff(handoff.id), memories_created: memories.length, memories });
  }
  if (action === "get") {
    if (!id && !key) return { content: [{ type: "text", text: "handoff get requires id or key. To retrieve by project, use handoff list or resume check." }], isError: true };
    const handoff = dbStore.getHandoff(id || key);
    if (!handoff) return { content: [{ type: "text", text: "Handoff not found" }], isError: true };
    return jsonText({ ok: true, handoff });
  }
  if (action === "list") return jsonText({ ok: true, handoffs: dbStore.listHandoffs({ project, includeArchived: include_archived === true, limit: limit || 50 }) });
  if (action === "inspect") {
    if (!id && !key) return { content: [{ type: "text", text: "handoff inspect requires id or key. To retrieve by project, use handoff list or resume check." }], isError: true };
    const handoff = dbStore.getHandoff(id || key);
    if (!handoff) return { content: [{ type: "text", text: "Handoff not found" }], isError: true };
    const memories = dbStore.searchMemories({ project: handoff.project, includeDisabled: true, limit: 200 }).filter(m => m.source_ref === handoff.id || m.metadata?.handoff_id === handoff.id);
    return jsonText({ ok: true, handoff, extracted_memories: memories, extraction_version: HANDOFF_EXTRACTION_VERSION });
  }
  if (action === "reprocess") {
    const handoff = dbStore.getHandoff(id || key);
    if (!handoff) return { content: [{ type: "text", text: "Handoff not found" }], isError: true };
    const memories = extractHandoffMemories(handoff, { project: project || handoff.project });
    recordHandoffEvent("memory.handoff_reprocessed", { handoff_id: handoff.id, key: handoff.kv_key, project: handoff.project, version: handoff.version, memories_created_or_confirmed: memories.length }, { subjectType: "memory_handoff", subjectId: handoff.id, project: handoff.project, taskId: handoff.task_id });
    return jsonText({ ok: true, handoff: dbStore.getHandoff(handoff.id), memories_created_or_confirmed: memories.length, memories });
  }
  if (action === "archive") {
    const ok = dbStore.archiveHandoff(id || key);
    if (ok) recordHandoffEvent("memory.handoff_archived", { handoff_id: id || key }, { subjectType: "memory_handoff", subjectId: id || key, project });
    return { content: [{ type: "text", text: ok ? "Handoff archived" : "Handoff not found" }], isError: !ok };
  }
  if (action === "compare") {
    const handoffs = dbStore.listHandoffs({ project, includeArchived: true, limit: 2 });
    return jsonText({ ok: true, comparison: handoffs.map(h => ({ id: h.id, key: h.kv_key, version: h.version, hash: h.content_hash, updated_at: h.updated_at })) });
  }
  return { content: [{ type: "text", text: "Invalid action. Use create, update, get, list, compare, inspect, reprocess, archive" }], isError: true };
}

const descriptors = Object.freeze([Object.freeze({
  name: "handoff",
  description: "First-class handoff storage and ingestion. Preserves full handoff artifacts while extracting redacted, evidence-linked structured memories idempotently. get/inspect require id or key; use list or resume check for project-level queries.",
  schema: z.object({ action: z.enum(["create", "update", "get", "list", "compare", "inspect", "reprocess", "archive"]).describe("Handoff action"), id: z.string().optional(), key: z.string().optional().describe("KV key for backward-compatible handoffs"), project: z.string().optional(), title: z.string().optional(), content: z.string().optional(), source: z.string().optional(), task_id: z.string().optional(), reprocess: z.boolean().optional(), include_archived: z.boolean().optional(), limit: z.number().optional() }),
  args: { action: "string (create|update|get|list|compare|inspect|reprocess|archive)", id: "string (required for get/inspect, optional for other actions)", key: "string (required for get/inspect when id is omitted, optional for other actions)", project: "string (optional, for create/update/list/compare)", title: "string (optional)", content: "string (for create/update)", source: "string (optional)", task_id: "string (optional)", include_archived: "boolean (optional)", limit: "number (optional)" },
  risk: "medium",
  category: "Context & Learning",
  source: "builtin",
  family: "memory-handoff",
  handler: sidekick_handoff,
})]);

module.exports = { descriptors, sidekick_handoff, extractHandoffMemories };
