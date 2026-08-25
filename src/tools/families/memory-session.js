"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const platformKernel = require("../../platform/kernel");
const { redactSensitive } = require("../../redact");
const { buildMemoryBrief } = require("../../memory");
const toolContext = require("../context");

function jsonText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

function mergePacketEntries(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

function recordPlatformMemoryEvent(eventType, payload = {}, options = {}) {
  try {
    platformKernel.appendEvent({
      event_type: eventType,
      source: "memory",
      actor_id: options.actor || toolContext.getExecutionSource() || "unknown",
      subject_type: options.subjectType || null,
      subject_id: options.subjectId || null,
      project_id: options.project || payload.project || null,
      task_id: options.taskId || payload.task_id || payload.taskId || null,
      session_id: options.sessionId || payload.session_id || payload.sessionId || null,
      severity: options.severity || "info",
      payload,
      sensitivity: "normal",
      correlation_id: options.correlationId || options.taskId || payload.task_id || payload.taskId || options.subjectId || null,
    });
  } catch (e) {}
}

function buildScopedMemoryBrief(goal, project, options = {}) {
  const current = dbStore.searchMemories({ project, type: options.type || "all", limit: options.limit || 30 })
    .filter(memory => memory.current !== false && memory.state !== "expired" && memory.state !== "deleted")
    .map(memory => ({
      id: memory.id,
      type: memory.type,
      class: memory.memory_class,
      scope: `${memory.primary_scope_type || (memory.project ? "project" : "global")}:${memory.primary_scope_id || memory.project || "global"}`,
      summary: memory.summary || memory.content,
      confidence: memory.confidence,
      source: memory.source,
      source_ref: memory.source_ref,
      last_verified: memory.last_confirmed_at || memory.last_seen_at,
      why_selected: project && memory.project === project ? "project scope match" : "global or unscoped match",
    }));
  const legacyBrief = buildMemoryBrief(goal || project || "memory", { project }) || null;
  return { goal: goal || null, project: project || null, selected: current.slice(0, options.limit || 10), sections: legacyBrief, excluded_policy: "Expired, deleted, disabled, superseded, and unrelated project memories are excluded from normal recall.", generated_at: new Date().toISOString() };
}

function buildContinuationPacket(existing, input = {}) {
  const reports = Array.isArray(input.reports) ? input.reports : [];
  const priorPacket = input.handoff?.packet || {};
  const reportArtifacts = reports.map((report, index) => ({
    type: "subagent_report",
    id: report.id || `${existing.id}-report-${index + 1}`,
    source: report.source || report.agent || "subagent",
    title: report.title || `Subagent report ${index + 1}`,
    content: redactSensitive(String(report.content || report.summary || "")),
    evidence: Array.isArray(report.evidence) ? report.evidence : [],
  })).filter(report => report.content);
  const contextArtifacts = [];
  if (existing.supplied_context) contextArtifacts.push({ type: "session_context", content: redactSensitive(existing.supplied_context), source_task_id: existing.id });
  if (existing.current_plan) contextArtifacts.push({ type: "session_plan", content: redactSensitive(existing.current_plan), source_task_id: existing.id });
  const allArtifacts = mergePacketEntries(
    priorPacket.artifacts,
    Array.isArray(input.artifacts) ? input.artifacts : existing.artifacts || [],
    contextArtifacts,
    reportArtifacts
  );
  const evidenceItems = (Array.isArray(input.evidence) ? input.evidence : input.evidence ? [input.evidence] : []).map((item, index) => ({
    type: "session",
    label: `Session evidence ${index + 1}`,
    status: "recorded",
    content: redactSensitive(String(item)),
    source_task_id: existing.id,
  }));
  const evidence = mergePacketEntries(priorPacket.evidence, evidenceItems);
  const acceptance = input.acceptance_state || existing.acceptance_state;
  const priorProvenance = priorPacket.provenance || {};
  const acceptanceCriteria = mergePacketEntries(
    priorPacket.acceptance_criteria,
    acceptance ? [`Session acceptance: ${acceptance}`] : []
  );
  return {
    objective: existing.goal,
    summary: redactSensitive(input.final_summary || input.user_visible_result || input.outcome || existing.outcome || ""),
    status: input.state || "completed",
    completed_steps: input.completed_steps || existing.completed_steps || [],
    decisions: input.decisions || priorPacket.decisions || [],
    blockers: input.blockers || existing.blockers || priorPacket.blockers || [],
    next_step: input.next_step || existing.next_step || priorPacket.next_step || null,
    acceptance_criteria: acceptanceCriteria,
    risks: input.risks || priorPacket.risks || [],
    provenance: {
      ...priorProvenance,
      repository: existing.repository || priorProvenance.repository || null,
      branch: existing.branch || priorProvenance.branch || null,
      working_directory: existing.working_directory || priorProvenance.working_directory || null,
      environment: existing.environment || priorProvenance.environment || null,
      task_id: existing.id,
      handoff_id: input.handoff?.id || priorProvenance.handoff_id || null,
      handoff_version: input.handoff?.version || priorProvenance.handoff_version || null,
    },
    evidence,
    artifacts: allArtifacts,
    relationships: input.relationships || priorPacket.relationships || [],
    failed_approaches: input.failed_approaches || priorPacket.failed_approaches || [],
    do_not_repeat: input.do_not_repeat || priorPacket.do_not_repeat || [],
  };
}

function continuationQualityIssues(packet) {
  const issues = [];
  if (!packet.objective) issues.push("continuation packet requires the session goal");
  if (!packet.summary) issues.push("continuation packet requires a current summary");
  if (!packet.next_step && !["completed", "abandoned"].includes(packet.status)) issues.push("continuation packet requires an exact next step");
  if (packet.status === "completed" && (!Array.isArray(packet.acceptance_criteria) || packet.acceptance_criteria.length === 0)) issues.push("completed continuation packet requires acceptance_state");
  if (!packet.provenance || !packet.provenance.task_id) issues.push("continuation packet requires task provenance");
  return issues;
}

async function sidekick_session({ action, id, goal, project, source, working_directory, repository, branch, environment, client_session_id, tags, supplied_context, current_plan, completed_steps, current_hypothesis, evidence, blockers, next_step, artifacts, reports, risks, relationships, do_not_repeat, outcome, final_summary, user_visible_result, acceptance_state, decisions, verified_facts, unresolved_issues, resolved_issues, failed_approaches, procedures_learned, follow_ups, usefulness_feedback, handoff_id, limit }) {
  const authIdentity = toolContext.getExecutionContext().authIdentity || null;
  const ownerPrincipalId = authIdentity?.acting_for_principal_id || authIdentity?.principal_id || null;
  const actorPrincipalId = authIdentity?.principal_id || null;
  if (action === "begin") {
    if (!goal) return { content: [{ type: "text", text: "goal required" }], isError: true };
    const brief = buildScopedMemoryBrief(goal, project, { limit: 12 });
    const session = dbStore.saveTaskSession({ id, goal, project, source: source || toolContext.getExecutionSource(), client_session_id, working_directory, repository, branch, environment, tags: normalizeTags(tags), supplied_context, state: "active", memory_brief: brief, owner_principal_id: ownerPrincipalId, created_by_principal_id: actorPrincipalId });
    recordPlatformMemoryEvent("memory.session_started", { session_id: session.id, project: session.project, source: session.source, selected_memories: brief.selected.length }, { subjectType: "memory_task_session", subjectId: session.id, project: session.project, taskId: session.id });
    return jsonText({ ok: true, session, memory_brief: brief });
  }
  if (["update", "checkpoint"].includes(action)) {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const existing = dbStore.getTaskSession(id);
    if (!existing) return { content: [{ type: "text", text: "Task session not found: " + id }], isError: true };
    const session = dbStore.saveTaskSession({ ...existing, current_plan, completed_steps: completed_steps || existing.completed_steps, current_hypothesis, blockers: blockers || existing.blockers, next_step, artifacts: artifacts || existing.artifacts, state: "active", owner_principal_id: existing.owner_principal_id || ownerPrincipalId, created_by_principal_id: existing.created_by_principal_id || actorPrincipalId });
    recordPlatformMemoryEvent(action === "checkpoint" ? "memory.session_checkpointed" : "memory.session_updated", { session_id: session.id, project: session.project, action, completed_steps: Array.isArray(session.completed_steps) ? session.completed_steps.length : 0 }, { subjectType: "memory_task_session", subjectId: session.id, project: session.project, taskId: session.id });
    return jsonText({ ok: true, session, checkpoint: action === "checkpoint" });
  }
  if (action === "end" || action === "abandon") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const existing = dbStore.getTaskSession(id);
    if (!existing) return { content: [{ type: "text", text: "Task session not found: " + id }], isError: true };
    const state = action === "abandon" ? "abandoned" : "completed";
    const linkedHandoff = handoff_id ? dbStore.getHandoff(handoff_id) : null;
    const continuationPacket = handoff_id ? buildContinuationPacket(existing, { handoff: linkedHandoff, state, evidence, artifacts, reports, risks, relationships, do_not_repeat, outcome, final_summary, user_visible_result, acceptance_state, decisions, failed_approaches, next_step, completed_steps, blockers }) : null;
    let finalizedHandoff = null;
    let session;
    if (handoff_id) {
      const qualityIssues = continuationQualityIssues(continuationPacket);
      const validation = dbStore.validateHandoffPacket(continuationPacket, { requireResume: true });
      if (qualityIssues.length || !validation.valid) {
        return { content: [{ type: "text", text: `handoff quality gate failed: ${[...qualityIssues, ...validation.issues].join("; ")}` }], isError: true };
      }
      if (!linkedHandoff) return { content: [{ type: "text", text: `handoff quality gate failed: handoff "${handoff_id}" was not found` }], isError: true };
      try {
        const finalize = dbStore.getDb().transaction(() => {
          finalizedHandoff = dbStore.saveHandoff({ id: linkedHandoff.id, project: linkedHandoff.project, title: linkedHandoff.title, source: linkedHandoff.source, task_id: id, content: continuationPacket.summary, packet: continuationPacket, extraction_state: "pending", expectedVersion: linkedHandoff.version, owner_principal_id: linkedHandoff.owner_principal_id || ownerPrincipalId, created_by_principal_id: linkedHandoff.created_by_principal_id || actorPrincipalId });
          return dbStore.saveTaskSession({ ...existing, artifacts: continuationPacket.artifacts, outcome, final_summary: redactSensitive(final_summary || user_visible_result || outcome || ""), acceptance_state, state, ended_at: new Date().toISOString(), owner_principal_id: existing.owner_principal_id || ownerPrincipalId, created_by_principal_id: existing.created_by_principal_id || actorPrincipalId });
        });
        session = finalize();
      } catch (error) {
        return { content: [{ type: "text", text: `session finalization failed: ${String(error && error.message ? error.message : error)}` }], isError: true };
      }
    } else {
      session = dbStore.saveTaskSession({ ...existing, artifacts: artifacts || existing.artifacts, outcome, final_summary: redactSensitive(final_summary || user_visible_result || outcome || ""), acceptance_state, state, ended_at: new Date().toISOString(), owner_principal_id: existing.owner_principal_id || ownerPrincipalId, created_by_principal_id: existing.created_by_principal_id || actorPrincipalId });
    }
    const created = [];
    const projectName = project || existing.project;
    const add = (type, values, memoryClass, confidence) => {
      for (const value of Array.isArray(values) ? values : values ? [values] : []) {
        const text = redactSensitive(String(value || "").trim());
        if (!text) continue;
        const mem = dbStore.upsertMemory({ type, project: projectName, content: text, summary: text, confidence, source: "task_session", source_tool: "sidekick_session", source_task_id: id, source_ref: id, memory_class: memoryClass, evidence_excerpt: text, directness: "direct", source_authority: action === "abandon" ? 4 : 5, metadata: { task_session_id: id, outcome, acceptance_state, usefulness_feedback } });
        if (mem) created.push(mem);
      }
    };
    if (action !== "abandon" && !["rejected", "failed"].includes(String(acceptance_state || "").toLowerCase())) {
      add("fact", verified_facts, "semantic", 0.82); add("decision", decisions, "semantic", 0.84); add("procedure", procedures_learned, "procedural", 0.78); add("session", final_summary || user_visible_result, "episodic", 0.74);
    }
    add("negative", failed_approaches, "negative", 0.76); add("open_thread", [...(unresolved_issues || []), ...(follow_ups || [])].slice(0, 3), "prospective", 0.78); add("observation", evidence, "observational", 0.62);
    recordPlatformMemoryEvent(action === "abandon" ? "memory.session_abandoned" : "memory.session_completed", { session_id: session.id, project: session.project, memories_created: created.length, state: session.state, outcome }, { subjectType: "memory_task_session", subjectId: session.id, project: session.project, taskId: session.id, severity: action === "abandon" ? "warning" : "info" });
    return jsonText({ ok: true, session, handoff_id: handoff_id || null, handoff_version: finalizedHandoff ? finalizedHandoff.version : null, continuation_packet: continuationPacket, memories_created: created.length, memories: created });
  }
  if (action === "resume" || action === "status") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const session = dbStore.getTaskSession(id);
    if (!session) return { content: [{ type: "text", text: "Task session not found: " + id }], isError: true };
    return jsonText({ ok: true, session, memory_brief: buildScopedMemoryBrief(session.goal, session.project, { limit: 12 }) });
  }
  if (action === "list") return jsonText({ ok: true, sessions: dbStore.listTaskSessions({ project, state: source, limit: limit || 50 }) });
  return { content: [{ type: "text", text: "Invalid action. Use begin, update, checkpoint, end, abandon, resume, status, list" }], isError: true };
}

const descriptors = Object.freeze([Object.freeze({
  name: "session",
  description: "Explicit task/session memory envelope. Begin, checkpoint, end, abandon, resume, and list scoped work with a purpose-built memory brief.",
  schema: z.object({
    action: z.enum(["begin", "update", "checkpoint", "end", "abandon", "resume", "status", "list"]).describe("Session action"),
    id: z.string().optional().describe("Task/session ID"), goal: z.string().optional().describe("Task goal, required for begin"), project: z.string().optional().describe("Project scope"), source: z.string().optional().describe("Client/source label"), working_directory: z.string().optional(), repository: z.string().optional(), branch: z.string().optional(), environment: z.string().optional(), client_session_id: z.string().optional(), tags: z.union([z.string(), z.array(z.string())]).optional(), supplied_context: z.string().optional(), current_plan: z.string().optional(), completed_steps: z.array(z.any()).optional(), current_hypothesis: z.string().optional(), evidence: z.union([z.string(), z.array(z.string())]).optional(), next_step: z.string().optional(), blockers: z.array(z.any()).optional(), artifacts: z.array(z.any()).optional(), reports: z.array(z.any()).optional(), risks: z.array(z.any()).optional(), relationships: z.array(z.any()).optional(), do_not_repeat: z.array(z.any()).optional(), handoff_id: z.string().optional().describe("Structured handoff to finalize with the continuation packet on end/abandon"), outcome: z.string().optional(), final_summary: z.string().optional(), user_visible_result: z.string().optional(), acceptance_state: z.string().optional(), decisions: z.array(z.string()).optional(), verified_facts: z.array(z.string()).optional(), unresolved_issues: z.array(z.string()).optional(), resolved_issues: z.array(z.string()).optional(), failed_approaches: z.array(z.string()).optional(), procedures_learned: z.array(z.string()).optional(), follow_ups: z.array(z.string()).optional(), usefulness_feedback: z.string().optional(), limit: z.number().optional(),
  }),
  args: { action: "string (begin|update|checkpoint|end|abandon|resume|status|list)", id: "string (optional task/session id)", goal: "string (required for begin)", project: "string (optional)", source: "string (optional)", working_directory: "string (optional)", repository: "string (optional)", branch: "string (optional)", environment: "string (optional)", tags: "string|array (optional)", current_plan: "string (optional)", completed_steps: "array (optional)", blockers: "array (optional)", next_step: "string (optional)", artifacts: "array (optional)", reports: "array of subagent reports (optional, retained on linked handoff)", handoff_id: "string (optional, required to finalize a handoff on end/abandon)", risks: "array (optional)", relationships: "array (optional)", do_not_repeat: "array (optional)", outcome: "string (optional)", final_summary: "string (optional)", acceptance_state: "string (optional)", verified_facts: "array (optional)", decisions: "array (optional)", failed_approaches: "array (optional)", follow_ups: "array (optional)" },
  risk: "medium",
  category: "Context & Learning",
  source: "builtin",
  family: "memory-session",
  handler: sidekick_session,
})]);

module.exports = { descriptors, sidekick_session };
