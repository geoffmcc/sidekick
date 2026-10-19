"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const out = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
function failed(value) { const raw = value?.content?.map(item => item.text || "").join("\n").trim(); let data = null; try { data = raw ? JSON.parse(raw) : null; } catch {} const state = String(value?.state || value?.status || data?.state || data?.status || "").toLowerCase(); return value?.isError === true || value?.ok === false || data?.ok === false || ["unavailable", "error", "failed"].includes(state); }
async function assess(services, args) {
  const minimum = args.minimum_evidence || services.config?.minimum_evidence || 1;
  if (!Array.isArray(args.evidence) || args.evidence.length < minimum) return out({ ok: false, ready: false, code: "evidence_required", error: `readiness requires at least ${minimum} evidence reference(s); no readiness claim was made` });
   const evidence = await services.dispatch("research_evidence", { action: "inspect", project_id: args.project, references: args.evidence.slice(0, 20) });
   if (failed(evidence)) return out({ ok: false, ready: false, state: "unavailable", code: "evidence_unavailable", error: "evidence references could not be inspected" });
  const health = await services.dispatch("health", { check: "all" });
  const profile = await services.dispatch("dev_repo_profile", { path: args.path, max_files: args.max_files || 500, include_semantic: false });
  const handoff = await services.dispatch("handoff", { action: "list", project: args.project, limit: 10 });
   const sources = { health, repository: profile, continuity: handoff };
   const failedSources = Object.entries(sources).filter(([, value]) => failed(value)).map(([name]) => name);
   const observed = failedSources.length === 0;
    return { ...out({ ok: observed, status: failedSources.length === Object.keys(sources).length ? "unavailable" : failedSources.length ? "partial" : "observed", unavailable_sources: failedSources, tool: "operational_readiness", ready: false, disposition: "requires_operator_interpretation", evidence, ...sources, gates: { evidence_present: true, health_observed: !failed(health), repository_observed: !failed(profile), continuity_observed: !failed(handoff), readiness_claim: false }, limitations: ["A healthy observation and evidence references do not prove deployment readiness; apply service-specific gates and currentness checks."] }), isError: !observed };
}
 const entry = { buildDescriptors(services) { return [{ name: "operational_readiness", aliases: ["readiness"], description: "Fail-closed readiness assessment. Requires attributable research evidence, then reads current health, repository profile and handoff; never claims ready automatically.", schema: z.object({ project: z.string().regex(/^[a-z0-9_]{1,100}$/), path: z.string().min(1).max(2048), evidence: z.array(z.string().min(1).max(500)).min(1).max(20), minimum_evidence: z.number().int().min(1).max(20).optional(), max_files: z.number().int().min(1).max(2000).optional() }).strict(), args: { project: "string", path: "string", evidence: "array of evidence references", minimum_evidence: "number", max_files: "number" }, risk: "medium", category: "Operations", handler: async args => { try { return await assess(services, args); } catch (error) { return out({ ok: false, ready: false, error: error.message || String(error), code: "readiness_evidence_failed" }); } } }]; }, healthCheck() { return { ok: true, details: { fail_closed: true, evidence_required: true, automatic_ready_claim: false } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
