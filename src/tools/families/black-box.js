"use strict";

// Black Box tool family: black_box.
//
// Extracted from src/tools-legacy.js. A thin dispatch wrapper over the shared
// src/blackbox module. Depends only on zod, blackbox, tools/context, and the
// inference family's sidekick_llm (passed by reference into analyzeIncident)
// — never on tools-legacy.js. The handler body is verbatim; the local
// getCurrentSource() helper mirrors the legacy one via
// toolContext.getExecutionSource() || "unknown" (the established family
// substitution — setSource writes through to toolContext and has no
// production callers). Risk (medium) preserved from src/tools/metadata.js.

const { z } = require("zod");
const blackbox = require("../../blackbox");
const toolContext = require("../context");
const { sidekick_llm } = require("./inference");

function getCurrentSource() {
  return toolContext.getExecutionSource() || "unknown";
}

async function sidekick_black_box(args = {}) {
  const action = args.action || "list";
  try {
    if (action === "list" || action === "list_incidents") {
      const incidents = blackbox.listIncidents(args);
      if (action === "list") {
        if (!incidents.length) return { content: [{ type: "text", text: "No incidents captured" }] };
        const list = incidents.map(inc => `${inc.id}: ${inc.title} (${inc.lifecycle_state}, ${inc.severity}, expires ${inc.expires_at || "never"})`).join("\n");
        return { content: [{ type: "text", text: `Incidents (${incidents.length}):\n\n${list}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ incidents }, null, 2) }] };
    }

    if (action === "get" || action === "get_incident") {
      if (!args.incident_id) return { content: [{ type: "text", text: "incident_id required" }], isError: true };
      // Keep the structured retrieval response bounded. Timelines and full
      // analysis history are opt-in because a normal Sidekick capture can
      // contain hundreds of event metadata objects.
      const incident = blackbox.getIncident(args.incident_id, {
        includeTimeline: args.include_timeline === true,
        includeAnalysis: args.include_analysis === true
      });
      if (!incident) return { content: [{ type: "text", text: `Incident not found: ${args.incident_id}` }], isError: true };
      if (action === "get" && args.raw !== false) {
        const firstCapture = (incident.captures || [])[0];
        const sources = firstCapture ? blackbox.listSources(firstCapture.id).map(source => blackbox.getSource(source.id, { limit: 32768 })) : [];
        const raw = [`# Black Box Incident ${incident.id}`, `Title: ${incident.title}`, `State: ${incident.lifecycle_state}`, ""];
        for (const source of sources) raw.push(`## ${source.display_name} (${source.state})`, source.stdout || "", source.stderr ? `\nSTDERR:\n${source.stderr}` : "");
        return { content: [{ type: "text", text: raw.join("\n") }] };
      }
      if (args.include_sources !== false) {
        incident.captures = (incident.captures || []).map(capture => ({
          ...capture,
          sources: blackbox.listSources(capture.id)
        }));
      }
      return { content: [{ type: "text", text: JSON.stringify(incident, null, 2) }] };
    }

    if (action === "capture") {
      const capture = await blackbox.captureIncident({ ...args, source: getCurrentSource() });
      let payload = {
        incident_id: capture.incident_id,
        id: capture.id,
        capture_id: capture.id,
        state: capture.state,
        profile: capture.profile,
        source_count: capture.source_count,
        succeeded_count: capture.succeeded_count,
        failed_count: capture.failed_count,
        timed_out_count: capture.timed_out_count,
        truncated_count: capture.truncated_count,
        total_bytes: capture.total_bytes,
        sources: (capture.sources || []).map(source => ({ id: source.id, key: source.source_key, state: source.state, duration_ms: source.duration_ms, exit_code: source.exit_code, timed_out: source.timed_out, truncated: source.truncated }))
      };
      if (args.analyze_with_llm) payload.analysis = await blackbox.analyzeIncident(capture.incident_id, { capture_id: capture.id, llm: sidekick_llm, actor: getCurrentSource() });
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (action === "capture_status") return { content: [{ type: "text", text: JSON.stringify(blackbox.captureStatus(args.capture_id), null, 2) }] };
    if (action === "cancel_capture") return { content: [{ type: "text", text: JSON.stringify(blackbox.cancelCapture(args.capture_id), null, 2) }] };
    if (action === "retry_capture") return { content: [{ type: "text", text: JSON.stringify(await blackbox.retryCapture(args.capture_id, { ...args, source: getCurrentSource() }), null, 2) }] };
    if (action === "repair") return { content: [{ type: "text", text: JSON.stringify(blackbox.repairEmptyCapture(args.capture_id), null, 2) }] };
    if (action === "list_captures") return { content: [{ type: "text", text: JSON.stringify({ captures: blackbox.listCaptures(args.incident_id) }, null, 2) }] };
    if (action === "get_capture") return { content: [{ type: "text", text: JSON.stringify(blackbox.getCapture(args.capture_id, { includeSources: true }), null, 2) }] };
    if (action === "list_sources") return { content: [{ type: "text", text: JSON.stringify({ sources: blackbox.listSources(args.capture_id) }, null, 2) }] };
    if (action === "get_source") return { content: [{ type: "text", text: JSON.stringify(blackbox.getSource(args.source_id, { offset: args.offset, limit: args.limit }), null, 2) }] };
    if (action === "search") return { content: [{ type: "text", text: JSON.stringify({ results: blackbox.searchIncidents(args.query, args) }, null, 2) }] };
    if (action === "analyze") return { content: [{ type: "text", text: JSON.stringify(await blackbox.analyzeIncident(args.incident_id, { capture_id: args.capture_id, llm: args.use_llm === false ? null : sidekick_llm, actor: getCurrentSource() }), null, 2) }] };
    if (action === "analyze_async") return { content: [{ type: "text", text: JSON.stringify(await blackbox.startAnalysis(args.incident_id, { capture_id: args.capture_id, llm: sidekick_llm, timeout_ms: args.analysis_timeout_ms, actor: getCurrentSource() }), null, 2) }] };
    if (action === "compare") return { content: [{ type: "text", text: JSON.stringify(blackbox.compareCaptures(args.capture_id, args.compare_capture_id), null, 2) }] };
    if (action === "add_note") return { content: [{ type: "text", text: JSON.stringify(blackbox.addNote(args.incident_id, { content: args.note || args.content, type: args.note_type, source: getCurrentSource() }), null, 2) }] };
    if (action === "update_incident") return { content: [{ type: "text", text: JSON.stringify(blackbox.updateIncident(args.incident_id, args, getCurrentSource()), null, 2) }] };
    if (action === "pin") return { content: [{ type: "text", text: JSON.stringify(blackbox.updateIncident(args.incident_id, { pinned: true, retention_class: "pinned", reason: args.reason }, getCurrentSource()), null, 2) }] };
    if (action === "extend_retention") return { content: [{ type: "text", text: JSON.stringify(blackbox.updateIncident(args.incident_id, { retention_class: args.retention_class || "important", reason: args.reason }, getCurrentSource()), null, 2) }] };
    if (action === "archive") return { content: [{ type: "text", text: JSON.stringify(blackbox.updateIncident(args.incident_id, { lifecycle_state: "archived", retention_class: "archive", reason: args.reason }, getCurrentSource()), null, 2) }] };
    if (action === "export") return { content: [{ type: "text", text: typeof blackbox.exportIncident(args.incident_id, args) === "string" ? blackbox.exportIncident(args.incident_id, args) : JSON.stringify(blackbox.exportIncident(args.incident_id, args), null, 2) }] };
    if (action === "delete") {
      if (!args.incident_id) return { content: [{ type: "text", text: "incident_id required" }], isError: true };
      if (!blackbox.deleteIncident(args.incident_id, getCurrentSource())) return { content: [{ type: "text", text: `Incident not found: ${args.incident_id}` }], isError: true };
      return { content: [{ type: "text", text: `Deleted incident: ${args.incident_id}` }] };
    }
    if (action === "storage_status") return { content: [{ type: "text", text: JSON.stringify(blackbox.storageStatus(), null, 2) }] };
    if (action === "purge_preview") return { content: [{ type: "text", text: JSON.stringify(blackbox.purgePreview(), null, 2) }] };
    if (action === "purge") return { content: [{ type: "text", text: JSON.stringify(blackbox.purgeExpired({ confirm: !!args.confirm }), null, 2) }] };
    if (action === "profiles") return { content: [{ type: "text", text: JSON.stringify(blackbox.PROFILE_INFO, null, 2) }] };
    return { content: [{ type: "text", text: "Unknown action. Use: capture, capture_status, cancel_capture, list_incidents, get_incident, list_captures, get_capture, list_sources, get_source, search, analyze, compare, add_note, update_incident, pin, extend_retention, archive, export, delete, storage_status, purge_preview, purge, profiles" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
}

const SCHEMAS = {
  black_box: z.object({
    action: z.enum([
      "capture", "capture_status", "cancel_capture", "retry_capture", "repair", "list", "get", "delete", "analyze",
      "list_incidents", "get_incident", "list_captures", "get_capture", "list_sources", "get_source",
      "search", "compare", "add_note", "update_incident", "verify", "pin", "extend_retention", "analyze_async",
      "archive", "export", "storage_status", "purge_preview", "purge", "profiles"
    ]),
    name: z.string().optional().describe("Incident name/title"),
    title: z.string().optional().describe("Incident title"),
    description: z.string().optional().describe("Incident description"),
    project: z.string().optional(),
    environment: z.string().optional(),
    severity: z.string().optional(),
    lifecycle_state: z.string().optional(),
    pinned: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    profile: z.enum(["quick", "standard", "deep", "network", "service", "sidekick", "repository", "custom"]).optional(),
    include: z.array(z.string()).optional().describe("Legacy sections or collector keys"),
    analyze_with_llm: z.boolean().optional().default(false),
    use_llm: z.boolean().optional().default(false),
    include_timeline: z.boolean().optional().default(false),
    include_analysis: z.boolean().optional().default(false),
    include_sources: z.boolean().optional().default(true),
    analysis_timeout_ms: z.number().int().min(1000).max(86400000).optional(),
    incident_id: z.string().optional(),
    capture_id: z.string().optional(),
    compare_capture_id: z.string().optional(),
    source_id: z.string().optional(),
    query: z.string().optional(),
    note: z.string().optional(),
    content: z.string().optional(),
    note_type: z.string().optional(),
    retention_class: z.string().optional(),
    reason: z.string().optional(),
    format: z.enum(["json", "markdown"]).optional(),
    raw: z.boolean().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
    confirm: z.boolean().optional().default(false)
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "black_box",
    description: "Structured Black Box incident evidence system: captures profiled system context, stores searchable incidents/captures/sources/observations, supports live status, evidence-cited analysis, comparison, retention, export, and legacy list/get/delete compatibility.",
    schema: SCHEMAS.black_box,
    args: { action: "string (capture|capture_status|cancel_capture|list|list_incidents|get|get_incident|list_captures|get_capture|list_sources|get_source|search|analyze|compare|add_note|update_incident|pin|extend_retention|archive|export|delete|storage_status|purge_preview|purge|profiles)", name: "string (optional, incident title)", profile: "string (optional, quick|standard|deep|network|service|sidekick|repository|custom)", include: "array (optional, legacy sections or collector keys)", incident_id: "string (optional)", capture_id: "string (optional)", source_id: "string (optional)", query: "string (optional)", analyze_with_llm: "boolean (optional)", retention_class: "string (optional)", confirm: "boolean (optional for purge)" },
    risk: "medium",
    category: "Monitoring",
    source: "builtin",
    family: "black-box",
    handler: sidekick_black_box,
  }),
]);

module.exports = { descriptors, sidekick_black_box };
