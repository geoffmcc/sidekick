"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const out = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = message => ({ ...out({ ok: false, state: "unavailable", error: message, code: "verification_failed" }), isError: true });
function decode(value) { try { return JSON.parse(value?.content?.map(item => item.text || "").join("") || ""); } catch { return value; } }
function usable(value) { return value !== null && value !== undefined && !value.isError; }
async function verify(services, args) {
  const checks = {
    profile: await services.dispatch("dev_repo_profile", { path: args.path, include_git: true, include_semantic: false, max_files: args.max_files || 500 }),
    semantic: await services.dispatch("semantic_repo", { path: args.path, action: "verify", level: 0 }),
    health: await services.dispatch("health", { check: "all" }),
  };
  if (args.snapshot) checks.snapshot = await services.dispatch("snapshot", { action: "compare", compare: args.snapshot });
  const sources = Object.keys(checks).filter(key => usable(checks[key]));
  const complete = sources.length === Object.keys(checks).length;
  return { ...out({ ok: complete && sources.length > 0, state: complete ? "available" : sources.length ? "incomplete" : "unavailable", tool: "skeptical_verify", verdict: complete ? "evidence_collected" : sources.length ? "evidence_incomplete" : "unavailable", independent: true, read_only: true, executed_project_commands: false, checks, evidence: { sources, source_count: sources.length, scope: { repository: args.path, snapshot: args.snapshot || null } }, interpretation_required: true, limitations: ["Collected checks are not proof of correctness or production equivalence.", "Source freshness is not asserted unless the source itself provides a timestamp."] }), isError: !complete || sources.length === 0 };
}
async function compare(services, args) {
  try {
    const comparison = await services.dispatch("research_compare", { baseline: args.baseline, candidate: args.candidate, baseline_evidence: args.baseline_evidence, candidate_evidence: args.candidate_evidence, mode: args.mode || "auto" });
    return out({ ok: !comparison?.isError, state: comparison?.isError ? "unavailable" : "available", verdict: comparison?.isError ? "unavailable" : "compared", independent: true, comparison: decode(comparison), interpretation_required: true, no_equivalence_claim: true });
  } catch (error) { return fail(error.message || "comparison unavailable"); }
}
const entry = { buildDescriptors(services) { return [
  { name: "skeptical_verify", aliases: ["independent_verify"], description: "Independent read-only verification using repository, semantic, health and optional snapshot checks.", schema: z.object({ path: z.string().min(1).max(2048), snapshot: z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/).optional(), max_files: z.number().int().min(1).max(2000).optional() }).strict(), args: { path: "string", snapshot: "string", max_files: "number" }, risk: "low", category: "Verification", handler: async args => { try { return await verify(services, args); } catch (error) { return fail(error.message || String(error)); } } },
  { name: "skeptical_compare", description: "Compare independent values or evidence references mechanically without converting disagreement into a claim.", schema: z.object({ baseline: z.any().optional(), candidate: z.any().optional(), baseline_evidence: z.string().max(200).optional(), candidate_evidence: z.string().max(200).optional(), mode: z.enum(["status", "hash", "text", "json", "auto"]).optional() }).strict(), args: { baseline: "any", candidate: "any", baseline_evidence: "string", candidate_evidence: "string", mode: "string" }, risk: "low", category: "Verification", handler: args => compare(services, args) },
] }, healthCheck() { return { ok: true, details: { mode: "independent_read_only", project_commands: false, state_mutations: false, unavailable_is_failure: true } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
