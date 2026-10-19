"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const identifier = value => typeof value === "string" && IDENTIFIER.test(value);
function result(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function unavailable(error) { return { ok: false, state: "unavailable", code: error?.code || "provider_unavailable", error: String(error?.message || error).slice(0, 300) }; }
function failedEvidence(value) { return value?.isError === true || value?.ok === false || ["unavailable", "error", "failed"].includes(String(value?.state || value?.status || "").toLowerCase()); }
async function read(services, name, args) {
  try {
    const value = await services.dispatch(name, args);
    return failedEvidence(value) ? unavailable({ code: value?.code || "provider_error", message: "provider returned an unavailable or failed result" }) : value;
  } catch (error) { return unavailable(error); }
}

function buildDescriptors(services) {
  return [
    {
      name: "observability_incident_snapshot",
      description: "Capture a bounded incident snapshot through the structured Black Box evidence system; capture failures are returned, never hidden.",
      schema: z.object({ name: z.string().min(1).max(120).regex(/^[^\u0000\r\n]+$/).describe("Short operator-visible incident capture name; do not include secrets."), profile: z.enum(["quick", "standard", "deep", "network", "service", "sidekick", "repository", "custom"]).optional().describe("Configured Black Box capture profile; omit to use the administrator default."), project: z.string().regex(IDENTIFIER).optional().describe("Canonical project identifier for evidence association, when applicable."), severity: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).optional().describe("Operator-selected incident severity label.") }).strict(),
      args: { name: "string (short incident capture name; no secrets)", profile: "string (configured Black Box profile; omit for default)", project: "string (canonical project identifier; optional)", severity: "string (operator-selected severity label)" }, risk: "medium", category: "Observability",
      handler: args => services.dispatch("black_box", { action: "capture", name: args.name, profile: args.profile || services.config?.default_profile, project: args.project || undefined, severity: args.severity }),
    },
    {
      name: "observability_health_review",
      description: "Return independent governed status and health evidence for incident triage without converting unavailable checks into healthy results.",
      schema: z.object({ check: z.enum(["all", "services", "processes", "disk", "network", "modules"]).optional().describe("Health subsystem to inspect; defaults to all."), services: z.string().max(2000).regex(/^[A-Za-z0-9_.@:-]+(?:,[A-Za-z0-9_.@:-]+)*$/).or(z.literal("")).optional().describe("Optional comma-separated service names from the configured host; leave empty for provider defaults.") }).strict(),
      args: { check: "string (all|services|processes|disk|network|modules; default all)", services: "string (optional comma-separated configured service names)" }, risk: "high", category: "Observability",
      handler: async args => {
        const status = await read(services, "status", { include: "services,disk,memory,load,uptime,processes,modules", services: args.services });
        const health = await read(services, "health", { check: args.check || "all", services: args.services });
        const failures = [failedEvidence(status), failedEvidence(health)].filter(Boolean).length;
        const collectionState = failures === 2 ? "unavailable" : failures === 1 ? "partial" : "observed";
        return result({ ok: collectionState !== "unavailable", status: collectionState, collection_state: collectionState, status_evidence: status, health, unavailable_is_not_healthy: true });
      },
    },
    {
      name: "observability_metrics_query",
      description: "Read or write metrics only through the governed metrics provider; the default operation is a bounded measurement listing.",
      schema: z.object({ action: z.enum(["list_measurements", "list_fields", "query", "write"]).describe("Metrics operation; write changes provider data and remains governed."), measurement: z.string().regex(IDENTIFIER).or(z.literal("")).optional().describe("Measurement name returned by list_measurements; required for list_fields and write."), query: z.string().min(1).max(4000).optional().describe("Provider-supported metrics query; required for query and limited to 4000 characters."), time_range: z.string().regex(/^-?[0-9]+[smhdw]$/).or(z.literal("")).optional().describe("Relative time window such as 1h or 7d, if supported by the provider."), fields: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.unknown()).optional().describe("Bounded field values for a governed write; required for write."), tags: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(255)).optional().describe("Optional bounded tag key/value pairs for a governed write.") }).strict(),
      args: { action: "string (list_measurements|list_fields|query|write; write is mutating)", measurement: "string (observed measurement name; required for list_fields and write)", query: "string (provider-supported query; required for query)", time_range: "string (relative window such as 1h or 7d)", fields: "object (bounded field values; required for write)", tags: "object (optional bounded tag key/value pairs)" }, risk: "high", category: "Observability",
      handler: args => {
        if ((args.action === "list_fields" || args.action === "write") && !identifier(args.measurement)) return result({ ok: false, code: "invalid_input", error: "measurement is required for this action" });
        if (args.action === "query" && (!args.query || args.query.length > 4000)) return result({ ok: false, code: "invalid_input", error: "query is required for query" });
        if (args.action === "write" && (!args.fields || typeof args.fields !== "object" || Array.isArray(args.fields))) return result({ ok: false, code: "invalid_input", error: "fields are required for write" });
        return services.dispatch("metrics", args);
      },
    },
    {
      name: "observability_incident_operation", description: "Inspect or analyze one existing incident or capture through the governed Black Box evidence system.",
      schema: z.object({ action: z.enum(["list_incidents", "get_incident", "list_captures", "get_capture", "search", "analyze"]).describe("Read-only incident or capture operation."), incident_id: z.string().regex(IDENTIFIER).optional().describe("Incident identifier from list_incidents or search; required for get_incident."), capture_id: z.string().regex(IDENTIFIER).optional().describe("Capture identifier from list_captures or an incident; required for get_capture."), query: z.string().max(500).optional().describe("Focused text query; required for search."), limit: z.number().int().min(1).max(100).optional().describe("Maximum number of records to return, from 1 to 100.") }).strict().superRefine((v, c) => { if (["get_incident"].includes(v.action) && !v.incident_id) c.addIssue({ code: "custom", message: "incident_id is required" }); if (v.action === "get_capture" && !v.capture_id) c.addIssue({ code: "custom", message: "capture_id is required" }); if (v.action === "search" && !v.query) c.addIssue({ code: "custom", message: "query is required" }); }),
      args: { action: "string", incident_id: "string", capture_id: "string", query: "string", limit: "number" }, risk: "medium", category: "Observability", annotations: { readOnlyHint: true },
      handler: async args => { const value = await read(services, "black_box", args); const failed = failedEvidence(value); return result({ ok: !failed, state: failed ? "unavailable" : "observed", action: args.action, data: value, evidence: [{ source: "black_box", action: args.action }], unavailable_is_not_healthy: true }); },
    },
  ];
}

function healthCheck({ config }) { const profile = config && config.default_profile; const valid = ["quick", "standard", "deep", "network", "service", "sidekick", "repository", "custom"].includes(profile); return { ok: valid, details: { profile, invalid_configuration: valid ? null : "default_profile must be a supported Black Box profile", evidence: "black_box provider", unavailable_state: "preserved", metrics_writes: "enabled only through governed metrics provider" } }; }
module.exports = { buildDescriptors, healthCheck };
