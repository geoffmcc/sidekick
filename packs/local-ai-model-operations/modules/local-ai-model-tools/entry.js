"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const MAX = 60000;
const body = value => String(value?.content?.[0]?.text || value || "").slice(0, MAX);
const failed = value => Boolean(value?.isError);
async function readiness(services, args) {
  const max = Math.min(args.max_models || services.config.max_models || 50, 100);
  const [overview, models, providers, nodes, jobs] = await Promise.all([
    services.dispatch("compute", { action: "overview" }),
    services.dispatch("compute_models", { action: "list", capability: args.capability, enabled: true }),
    services.dispatch("compute_providers", { action: "health_all" }),
    services.dispatch("compute_nodes", { action: "list", state: "enabled" }),
    services.dispatch("compute_jobs", { action: "stats" })
  ]);
   const checks = { overview: !failed(overview), models: !failed(models), providers: !failed(providers), workers: !failed(nodes), jobs: !failed(jobs) };
   return { content: [{ type: "text", text: JSON.stringify({ ok: Object.values(checks).every(Boolean), tool: "model_readiness", checks, capability: args.capability || null, max_models: max, overview: body(overview), models: body(models).slice(0, max * 1200), provider_health: body(providers), workers: body(nodes), job_stats: body(jobs), evidence: { sources: Object.keys(checks).filter(key => checks[key]) }, policy: { downloads: "not performed", direct_provider_access: "not performed", routing: "Compute only" } }, null, 2).slice(0, MAX) }] };
}
const entry = { buildDescriptors(services) { return [{ name: "model_readiness", description: "Report bounded Compute model, provider, worker and queue readiness without downloading models or bypassing routing", schema: z.object({ capability: z.string().max(200).optional(), max_models: z.number().int().min(1).max(100).optional() }).strict(), args: { capability: "string", max_models: "number" }, risk: "low", category: "Compute", handler: args => readiness(services, args) }]; }, healthCheck({ config }) { return { ok: (config.max_models || 50) <= 100, details: { max_models: config.max_models || 50, downloads: false, compute_only: true } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
