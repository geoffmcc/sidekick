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

async function sidekick_handoff({ action, id, key, project, title, content, source, task_id, reprocess, include_archived, limit, version, expected_version, reason, packet }) {
  const authIdentity = toolContext.getExecutionContext().authIdentity || null;
  const ownerPrincipalId = authIdentity?.acting_for_principal_id || authIdentity?.principal_id || null;
  const actorPrincipalId = authIdentity?.principal_id || null;
  if (action === "create" || action === "update") {
    const existing = id || key ? dbStore.getHandoff(id || key) : null;
    const handoffContent = content !== undefined && content !== null
      ? content
      : (key ? dbStore.getKV(key)?.value : existing?.content);
    if (!handoffContent) return { content: [{ type: "text", text: "content required, or provide key for an existing KV handoff" }], isError: true };
    // create and update are distinct intents: update must never silently mint
    // a new handoff (a typo'd id would fork the plan), and create must never
    // silently overwrite an existing one.
    if (action === "update" && !existing) {
      return { content: [{ type: "text", text: `handoff update requires an existing handoff; ${id || key ? `"${id || key}" was not found` : "provide id or key"}. Use create for a new handoff.` }], isError: true };
    }
    if (action === "create" && existing) {
      return { content: [{ type: "text", text: `Handoff "${existing.id}" already exists (v${existing.version}). Use update to add a new version.` }], isError: true };
    }
    if (packet !== undefined) {
      try {
        const validation = dbStore.validateHandoffPacket(packet);
        if (!validation.valid) return { content: [{ type: "text", text: `invalid handoff packet: ${validation.issues.join("; ")}` }], isError: true };
      } catch (error) {
        return { content: [{ type: "text", text: String(error && error.message ? error.message : error) }], isError: true };
      }
    }
    let handoff;
    try {
      handoff = dbStore.saveHandoff({ id, kv_key: key, project, title, source: source || toolContext.getExecutionSource(), task_id, content: handoffContent, packet, extraction_state: "pending", expectedVersion: action === "update" ? expected_version : undefined, owner_principal_id: existing?.owner_principal_id || ownerPrincipalId, created_by_principal_id: existing?.created_by_principal_id || actorPrincipalId });
    } catch (error) {
      return { content: [{ type: "text", text: String(error && error.message ? error.message : error) }], isError: true };
    }
    // Mirror to KV only AFTER the save succeeded: a rejected save (e.g. stale
    // expected_version) must not poison the KV entry that a later content-less
    // update would read back as authoritative.
    if (key && content) dbStore.setKV(key, handoff.content, project || dbStore.getKV(key)?.project || null, source || toolContext.getExecutionSource(), "handoff");
    const memories = extractHandoffMemories(handoff, { project });
    recordHandoffEvent("memory.handoff_processed", { handoff_id: handoff.id, key: handoff.kv_key, project: handoff.project, version: handoff.version, memories_created: memories.length, extraction_state: "processed" }, { subjectType: "memory_handoff", subjectId: handoff.id, project: handoff.project, taskId: handoff.task_id });
    return jsonText({ ok: true, handoff: dbStore.getHandoff(handoff.id), memories_created: memories.length, memories });
  }
  if (action === "get") {
    if (!id && !key) return { content: [{ type: "text", text: "handoff get requires id or key. To retrieve by project, use handoff list or resume check." }], isError: true };
    const handoff = version === undefined || version === null
      ? dbStore.getHandoff(id || key)
      : dbStore.getHandoffVersion(id || key, version);
    if (!handoff) return { content: [{ type: "text", text: version === undefined || version === null ? "Handoff not found" : `Handoff or version not found (v${version})` }], isError: true };
    return jsonText({ ok: true, handoff });
  }
  if (action === "versions") {
    if (!id && !key) return { content: [{ type: "text", text: "handoff versions requires id or key" }], isError: true };
    const versions = dbStore.listHandoffVersions(id || key);
    if (!versions.length) return { content: [{ type: "text", text: "Handoff not found" }], isError: true };
    return jsonText({ ok: true, handoff_id: versions[0].handoff_id, latest_version: versions[0].version, versions });
  }
  if (action === "restore") {
    if ((!id && !key) || version === undefined || version === null) return { content: [{ type: "text", text: "handoff restore requires id (or key) and version" }], isError: true };
    try {
      const result = dbStore.restoreHandoffVersion(id || key, version, { source: source || toolContext.getExecutionSource() });
      if (!result.no_op) {
        const memories = extractHandoffMemories(result.handoff, { project: project || result.handoff.project });
        recordHandoffEvent("memory.handoff_restored", { handoff_id: result.handoff.id, restored_from: result.restored_from, new_version: result.handoff.version, memories_created: memories.length }, { subjectType: "memory_handoff", subjectId: result.handoff.id, project: result.handoff.project, taskId: result.handoff.task_id });
      }
      return jsonText({ ok: true, restored_from: result.restored_from, no_op: result.no_op === true, handoff: dbStore.getHandoff(result.handoff.id) });
    } catch (error) {
      return { content: [{ type: "text", text: String(error && error.message ? error.message : error) }], isError: true };
    }
  }
  if (action === "unarchive") {
    const ok = dbStore.unarchiveHandoff(id || key);
    if (ok) recordHandoffEvent("memory.handoff_unarchived", { handoff_id: id || key }, { subjectType: "memory_handoff", subjectId: id || key, project });
    return { content: [{ type: "text", text: ok ? "Handoff unarchived" : "Handoff not found" }], isError: !ok };
  }
  if (action === "purge_version") {
    if ((!id && !key) || version === undefined || version === null) return { content: [{ type: "text", text: "handoff purge_version requires id (or key) and version, plus a reason" }], isError: true };
    if (!reason) return { content: [{ type: "text", text: "handoff purge_version requires an explicit reason (recorded in the audit trail)" }], isError: true };
    try {
      const result = dbStore.purgeHandoffVersion(id || key, version, { reason, source: source || toolContext.getExecutionSource() });
      recordHandoffEvent("memory.handoff_version_purged", { handoff_id: result.handoff_id, version: result.version, reason }, { subjectType: "memory_handoff", subjectId: result.handoff_id, project, severity: "warning" });
      return jsonText({ ok: true, ...result });
    } catch (error) {
      return { content: [{ type: "text", text: String(error && error.message ? error.message : error) }], isError: true };
    }
  }
  if (action === "list") return jsonText({ ok: true, handoffs: dbStore.listHandoffs({ project, includeArchived: include_archived === true, limit: limit || 50 }) });
  if (action === "inspect") {
    if (!id && !key) return { content: [{ type: "text", text: "handoff inspect requires id or key. To retrieve by project, use handoff list or resume check." }], isError: true };
    const handoff = dbStore.getHandoff(id || key);
    if (!handoff) return { content: [{ type: "text", text: "Handoff not found" }], isError: true };
    const memories = dbStore.searchMemories({ project: handoff.project, includeDisabled: true, limit: 200 }).filter(m => m.source_ref === handoff.id || m.metadata?.handoff_id === handoff.id);
    return jsonText({ ok: true, handoff, packet_validation: dbStore.validateHandoffPacket(handoff.packet, { requireResume: true }), extracted_memories: memories, extraction_version: HANDOFF_EXTRACTION_VERSION });
  }
  if (action === "validate") {
    if (!id && !key) return { content: [{ type: "text", text: "handoff validate requires id or key" }], isError: true };
    const handoff = dbStore.getHandoff(id || key);
    if (!handoff) return { content: [{ type: "text", text: "Handoff not found" }], isError: true };
    const validation = dbStore.validateHandoffPacket(handoff.packet, { requireResume: true });
    return jsonText({ ok: true, handoff_id: handoff.id, version: handoff.version, valid: validation.valid, issues: validation.issues, packet: validation.packet });
  }
  if (action === "verify") {
    if (!id && !key) return { content: [{ type: "text", text: "handoff verify requires id or key" }], isError: true };
    const handoff = dbStore.getHandoff(id || key);
    if (!handoff) return { content: [{ type: "text", text: "Handoff not found" }], isError: true };
    const verification = dbStore.verifyHandoffProvenance(handoff.packet, { requireResume: true });
    return jsonText({ ok: true, handoff_id: handoff.id, version: handoff.version, ...verification });
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
    // With an id/key: summarize that handoff's own version history. Without:
    // legacy behavior (two most recent handoffs for the project).
    if (id || key) {
      const versions = dbStore.listHandoffVersions(id || key);
      if (!versions.length) return { content: [{ type: "text", text: "Handoff not found" }], isError: true };
      return jsonText({ ok: true, comparison: versions.map(v => ({ id: v.handoff_id, version: v.version, hash: v.content_hash, bytes: v.content_bytes, created_at: v.created_at, current: v.current })) });
    }
    const handoffs = dbStore.listHandoffs({ project, includeArchived: true, limit: 2 });
    return jsonText({ ok: true, comparison: handoffs.map(h => ({ id: h.id, key: h.kv_key, version: h.version, hash: h.content_hash, updated_at: h.updated_at })) });
  }
  return { content: [{ type: "text", text: "Invalid action. Use create, update, get, list, versions, restore, compare, inspect, validate, reprocess, archive, unarchive, purge_version" }], isError: true };
}

const descriptors = Object.freeze([Object.freeze({
  name: "handoff",
  description: "First-class versioned handoff storage and ingestion with structured resume packets. Packets preserve objective, state, next steps, decisions, blockers, acceptance criteria, provenance, evidence, artifacts, risks, and relationships alongside every content version. validate checks structure and verify checks bounded local provenance. Existing prose-only callers remain supported.",
  schema: z.object({ action: z.enum(["create", "update", "get", "list", "versions", "restore", "compare", "inspect", "validate", "verify", "reprocess", "archive", "unarchive", "purge_version"]).describe("Handoff action"), id: z.string().optional(), key: z.string().optional().describe("KV key for backward-compatible handoffs"), project: z.string().optional(), title: z.string().optional(), content: z.string().optional(), source: z.string().optional(), task_id: z.string().optional(), reprocess: z.boolean().optional(), include_archived: z.boolean().optional(), limit: z.number().optional(), version: z.number().optional().describe("Version selector for get/restore/purge_version"), expected_version: z.number().optional().describe("Optimistic concurrency guard for update: fails if the current version differs"), reason: z.string().optional().describe("Required for purge_version; recorded in the audit trail"), packet: z.record(z.any()).optional().describe("Structured resume packet") }),
  args: { action: "string (create|update|get|list|versions|restore|compare|inspect|validate|verify|reprocess|archive|unarchive|purge_version)", id: "string (required for get/inspect/versions/restore/validate/verify/purge_version, optional for other actions)", key: "string (required for get/inspect/validate/verify when id is omitted, optional for other actions)", project: "string (optional, for create/update/list/compare)", title: "string (optional)", content: "string (for create/update)", source: "string (optional)", task_id: "string (optional)", packet: "object (structured resume packet, optional)", include_archived: "boolean (optional)", limit: "number (optional)", version: "number (get: fetch a historical version; restore/purge_version: target version)", expected_version: "number (update: fail if current version differs)", reason: "string (purge_version: required audit reason)" },
  risk: "medium",
  category: "Context & Learning",
  source: "builtin",
  family: "memory-handoff",
  handler: sidekick_handoff,
})]);

module.exports = { descriptors, sidekick_handoff, extractHandoffMemories };
