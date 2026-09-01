"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const identifier = value => typeof value === "string" && IDENTIFIER.test(value);
function result(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function unavailable(error) { return { state: "unavailable", code: error?.code || "provider_unavailable", error: String(error?.message || error).slice(0, 300) }; }
async function read(services, name, args) { try { return await services.dispatch(name, args); } catch (error) { return result(unavailable(error)); } }

function buildDescriptors(services) {
  return [
    {
      name: "observability_incident_snapshot",
      description: "Capture a bounded incident snapshot through the structured Black Box evidence system; capture failures are returned, never hidden.",
      schema: z.object({ name: z.string().min(1).max(120).regex(/^[^\u0000\r\n]+$/), profile: z.enum(["quick", "standard", "deep", "network", "service", "sidekick", "repository", "custom"]).optional(), project: z.string().regex(IDENTIFIER).optional(), severity: z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).optional() }).strict(),
      args: { name: "string", profile: "string", project: "string", severity: "string" }, risk: "medium", category: "Observability",
      handler: args => services.dispatch("black_box", { action: "capture", name: args.name, profile: args.profile || services.config?.default_profile, project: args.project || undefined, severity: args.severity }),
    },
    {
      name: "observability_health_review",
      description: "Return independent governed status and health evidence for incident triage without converting unavailable checks into healthy results.",
      schema: z.object({ check: z.enum(["all", "services", "processes", "disk", "network", "modules"]).optional(), services: z.string().max(2000).regex(/^[A-Za-z0-9_.@:-]+(?:,[A-Za-z0-9_.@:-]+)*$/).or(z.literal("")).optional() }).strict(),
      args: { check: "string", services: "string" }, risk: "high", category: "Observability",
      handler: async args => result({ status: await read(services, "status", { include: "services,disk,memory,load,uptime,processes,modules", services: args.services }), health: await read(services, "health", { check: args.check || "all", services: args.services }) }),
    },
    {
      name: "observability_metrics_query",
      description: "Read or write metrics only through the governed metrics provider; the default operation is a bounded measurement listing.",
      schema: z.object({ action: z.enum(["list_measurements", "list_fields", "query", "write"]), measurement: z.string().regex(IDENTIFIER).or(z.literal("")).optional(), query: z.string().min(1).max(4000).optional(), time_range: z.string().regex(/^-?[0-9]+[smhdw]$/).or(z.literal("")).optional(), fields: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.unknown()).optional(), tags: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(255)).optional() }).strict(),
      args: { action: "string (list_measurements|list_fields|query|write)", measurement: "string", query: "string", time_range: "string", fields: "object", tags: "object" }, risk: "high", category: "Observability",
      handler: args => {
        if ((args.action === "list_fields" || args.action === "write") && !identifier(args.measurement)) return result({ ok: false, code: "invalid_input", error: "measurement is required for this action" });
        if (args.action === "query" && (!args.query || args.query.length > 4000)) return result({ ok: false, code: "invalid_input", error: "query is required for query" });
        if (args.action === "write" && (!args.fields || typeof args.fields !== "object" || Array.isArray(args.fields))) return result({ ok: false, code: "invalid_input", error: "fields are required for write" });
        return services.dispatch("metrics", args);
      },
    },
  ];
}

function healthCheck({ config }) { const profile = config && config.default_profile; const valid = ["quick", "standard", "deep", "network", "service", "sidekick", "repository", "custom"].includes(profile); return { ok: valid, details: { profile, invalid_configuration: valid ? null : "default_profile must be a supported Black Box profile", evidence: "black_box provider", unavailable_state: "preserved", metrics_writes: "enabled only through governed metrics provider" } }; }
module.exports = { buildDescriptors, healthCheck };
