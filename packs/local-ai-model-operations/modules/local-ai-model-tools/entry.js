"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const MAX = 60000;
const body = value => String(value?.content?.[0]?.text || value || "").slice(0, MAX);
const failed = value => { const raw = value?.content?.map(item => item.text || "").join("\n").trim(); let data = null; try { data = raw ? JSON.parse(raw) : null; } catch {} const state = String(value?.state || value?.status || data?.state || data?.status || "").toLowerCase(); return value?.isError === true || value?.ok === false || data?.ok === false || ["unavailable", "error", "failed"].includes(state); };
async function read(services, name, args) { try { return await services.dispatch(name, args); } catch (error) { return { ok: false, state: "unavailable", code: error.code || "dependency_failed", error: String(error.message || error).slice(0, 300) }; } }
const bounded = value => { const serialized = JSON.stringify(value, null, 2); return serialized.length <= MAX ? serialized : JSON.stringify({ ok: false, code: "result_too_large", error: "bounded result exceeded output limit", evidence: [] }); };
async function readiness(services, args) {
  const max = Math.min(args.max_models || services.config.max_models || 50, 100);
  const [overview, models, providers, nodes, jobs] = await Promise.all([
    read(services, "compute", { action: "overview" }),
    read(services, "compute_models", { action: "list", capability: args.capability, enabled: true }),
    read(services, "compute_providers", { action: "health_all" }),
    read(services, "compute_nodes", { action: "list", state: "enabled" }),
    read(services, "compute_jobs", { action: "stats" })
  ]);
   const checks = { overview: !failed(overview), models: !failed(models), providers: !failed(providers), workers: !failed(nodes), jobs: !failed(jobs) };
   const failedCount = Object.values(checks).filter(value => !value).length;
   return { content: [{ type: "text", text: bounded({ ok: failedCount === 0, state: failedCount === Object.keys(checks).length ? "unavailable" : failedCount ? "partial" : "observed", tool: "model_readiness", checks, capability: args.capability || null, max_models: max, overview: body(overview), models: body(models).slice(0, max * 1200), provider_health: body(providers), workers: body(nodes), job_stats: body(jobs), evidence: { sources: Object.keys(checks).filter(key => checks[key]) }, policy: { downloads: "not performed", direct_provider_access: "not performed", routing: "Compute only" } }) }] };
}
async function route(services, args) {
  try { const value = await services.dispatch("compute_route", { action: "explain", workload_class: args.workload_class, capabilities_required: args.capabilities_required, data_classification: args.data_classification, trust_level: args.trust_level }); return { content: [{ type: "text", text: bounded({ ok: !failed(value), state: failed(value) ? "unavailable" : "observed", tool: "model_route_explain", routing: body(value), evidence: [{ source: "compute_route", action: "explain" }], policy: "Compute routing only; no provider call performed" }) }] }; }
  catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: error.code || "provider_unavailable", error: String(error.message || error).slice(0, 300), evidence: [] }) }] }; }
}
const entry = { buildDescriptors(services) { return [{ name: "model_readiness", description: "Report bounded Compute model, provider, worker and queue readiness without downloading models or bypassing routing", schema: z.object({ capability: z.string().max(200).optional(), max_models: z.number().int().min(1).max(100).optional() }).strict(), args: { capability: "string", max_models: "number" }, risk: "low", category: "Compute", handler: args => readiness(services, args) }, { name: "model_route_explain", description: "Explain one bounded Compute placement decision without invoking a model or provider directly.", schema: z.object({ workload_class: z.enum(["chat", "generate", "embeddings"]), capabilities_required: z.string().max(500).optional(), data_classification: z.enum(["public", "internal", "private"]).optional(), trust_level: z.enum(["untrusted", "limited", "trusted", "privileged"]).optional() }).strict(), args: { workload_class: "string", capabilities_required: "string", data_classification: "string", trust_level: "string" }, risk: "low", category: "Compute", annotations: { readOnlyHint: true }, handler: args => route(services, args) }]; }, healthCheck({ config }) { return { ok: (config.max_models || 50) <= 100, details: { max_models: config.max_models || 50, downloads: false, compute_only: true } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
